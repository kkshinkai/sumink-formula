import {
  CstKind,
  type CstElement,
  type CstMissingToken,
  type CstNode,
  type CstSkippedTokens,
} from "./cst.js";
import { diagnostic, sortDiagnostics, type Diagnostic, type DiagnosticCode } from "./diagnostic.js";
import { lex } from "./lexer.js";
import { isTriviaKind, SyntaxKind } from "./syntax-kind.js";
import { SourceText, textRange } from "./text.js";
import { TokenFlags, type SyntaxToken } from "./token.js";

export interface ParseResult {
  readonly source: SourceText;
  readonly tokens: readonly SyntaxToken[];
  readonly cst: CstNode;
  readonly diagnostics: readonly Diagnostic[];
}

export function parse(text: string | SourceText): ParseResult {
  const lexResult = lex(text);
  const parser = new Parser(lexResult.source, lexResult.tokens, lexResult.diagnostics);
  return parser.parseProgram();
}

type StructuralElement = CstNode | CstMissingToken | CstSkippedTokens;

const enum ParsingContext {
  ProgramExpressions,
  ArrayElements,
  ObjectMembers,
  ClosureParameters,
  BlockExpressions,
  CallArguments,
  LetBindings,
  MatchCases,
  GroupedExpression,
  ComputedObjectKey,
  ComputedSelector,
  IfCondition,
  IfBranch,
}

interface SeparatedListOptions {
  readonly context: ParsingContext;
  readonly separator: SyntaxKind;
  readonly parseElement: () => CstNode;
  readonly expectedElementMessage: string;
  readonly expectedSeparatorMessage: string;
  readonly requireElement?: boolean;
  readonly trailingSeparatorDiagnostic?: {
    readonly code: DiagnosticCode;
    readonly message: string;
  };
}

const enum RecoveryAction {
  Continue,
  Abort,
}

const enum Precedence {
  Lowest,
  Or,
  And,
  Match,
  Equality,
  Comparison,
  InfixCall,
  Additive,
  Multiplicative,
  Prefix,
}

const maximumExpressionDepth = 256;

class Parser {
  readonly #source: SourceText;
  readonly #tokens: readonly SyntaxToken[];
  readonly #diagnostics: Diagnostic[];
  readonly #diagnosticKeys = new Set<string>();
  readonly #diagnosticStarts = new Set<number>();
  readonly #parsingContexts: ParsingContext[] = [];
  #position = 0;
  #expressionDepth = 0;

  public constructor(
    source: SourceText,
    tokens: readonly SyntaxToken[],
    lexicalDiagnostics: readonly Diagnostic[],
  ) {
    this.#source = source;
    this.#tokens = tokens;
    this.#diagnostics = [...lexicalDiagnostics];
    lexicalDiagnostics.forEach((value) => {
      this.#diagnosticKeys.add(diagnosticKey(value));
      this.#diagnosticStarts.add(value.range.start);
    });
  }

  public parseProgram(): ParseResult {
    const start = this.#position;
    const children: StructuralElement[] = [];

    if (this.#peekKind() === SyntaxKind.EndOfFileToken) {
      this.#report("SF2000", "Expected an expression.");
      children.push(this.#node(CstKind.ErrorExpression, this.#position));
    } else {
      this.#parseSeparatedList(children, {
        context: ParsingContext.ProgramExpressions,
        separator: SyntaxKind.SemicolonToken,
        parseElement: () => this.#parseExpression(),
        expectedElementMessage: "Expected an expression.",
        expectedSeparatorMessage: "Expected ';' between top-level expressions.",
      });
    }

    this.#consumeIf(SyntaxKind.EndOfFileToken);
    const cst = this.#node(CstKind.Program, start, children);
    return {
      source: this.#source,
      tokens: this.#tokens,
      cst,
      diagnostics: sortDiagnostics(this.#diagnostics),
    };
  }

  #parseExpression(minimumPrecedence: number = Precedence.Lowest): CstNode {
    if (this.#expressionDepth >= maximumExpressionDepth) {
      const start = this.#position;
      const children: StructuralElement[] = [];
      this.#report("SF2006", `Expression nesting exceeds the limit of ${maximumExpressionDepth}.`);
      if (!this.#isRecoveryBoundary(this.#peekKind())) {
        children.push(this.#skipExpressionAtDepthLimit());
      }
      return this.#node(CstKind.ErrorExpression, start, children);
    }

    this.#expressionDepth += 1;
    try {
      return this.#parseExpressionWithinDepth(minimumPrecedence);
    } finally {
      this.#expressionDepth -= 1;
    }
  }

  #parseExpressionWithinDepth(minimumPrecedence: number): CstNode {
    let left = this.#parsePrefixOrPrimary();

    while (true) {
      const postfix = this.#peekKind();
      if (postfix === SyntaxKind.OpenParenToken) {
        left = this.#parseCallExpression(left);
        continue;
      }
      if (postfix === SyntaxKind.DotToken) {
        left = this.#parseFieldSelector(left);
        continue;
      }
      if (postfix === SyntaxKind.OpenBracketToken) {
        left = this.#parseComputedSelector(left);
        continue;
      }

      if (postfix === SyntaxKind.MatchKeyword && Precedence.Match >= minimumPrecedence) {
        left = this.#parseMatchExpression(left);
        continue;
      }

      const operator = this.#binaryOperator();
      if (operator === undefined) {
        const recovered = this.#parseInvalidInfixExpression(left);
        if (recovered !== undefined) {
          left = recovered;
          continue;
        }
        break;
      }
      if (operator.precedence < minimumPrecedence) {
        break;
      }

      const start = left.tokenRange.start;
      if (operator.recoveryDiagnostic !== undefined) {
        this.#report("SF2007", operator.recoveryDiagnostic);
      }
      this.#consume();
      const right = this.#parseExpression(operator.precedence + 1);
      left = this.#node(operator.nodeKind, start, [left, right]);
    }

    return left;
  }

  #parsePrefixOrPrimary(): CstNode {
    const kind = this.#peekKind();
    if (kind === SyntaxKind.MinusToken || kind === SyntaxKind.NotKeyword) {
      const start = this.#position;
      this.#consume();
      const operand = this.#parseExpression(Precedence.Prefix);
      return this.#node(CstKind.PrefixOperatorExpression, start, [operand]);
    }

    return this.#parsePrimary();
  }

  #parsePrimary(): CstNode {
    const start = this.#position;
    switch (this.#peekKind()) {
      case SyntaxKind.NumberLiteralToken:
      case SyntaxKind.StringLiteralToken:
      case SyntaxKind.NilKeyword:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        this.#consume();
        return this.#node(CstKind.LiteralExpression, start);
      case SyntaxKind.IdentifierToken:
        if (this.#looksLikeMisspelledLetExpression()) {
          this.#reportMisspelledKeyword("let");
          return this.#parseLetExpression();
        }
        this.#consume();
        return this.#node(CstKind.IdentifierExpression, start);
      case SyntaxKind.OpenBracketToken:
        return this.#parseArrayExpression();
      case SyntaxKind.OpenBraceToken:
        return this.#parseObjectExpression();
      case SyntaxKind.OpenParenToken:
        return this.#looksLikeClosure() ? this.#parseClosureExpression() : this.#parseGroupedExpression();
      case SyntaxKind.DoKeyword:
        return this.#parseBlockExpression();
      case SyntaxKind.IfKeyword:
        return this.#parseIfExpression();
      case SyntaxKind.LetKeyword:
        return this.#parseLetExpression();
      default: {
        return this.#parseErrorExpression(start);
      }
    }
  }

  #parseErrorExpression(start: number): CstNode {
    const children: StructuralElement[] = [];
    this.#reportPrimary("SF2000", "Expected an expression.");
    if (this.#isRecoveryBoundary(this.#peekKind())) {
      return this.#node(CstKind.ErrorExpression, start, children);
    }

    const skipped = this.#skipErrorIsland((kind) => this.#isErrorIslandBoundary(kind));
    if (skipped !== undefined) {
      children.push(skipped);
    }
    return this.#node(CstKind.ErrorExpression, start, children);
  }

  #parseInvalidInfixExpression(left: CstNode): CstNode | undefined {
    if (
      this.#peekKind() === SyntaxKind.EndOfFileToken
      || isClosingDelimiter(this.#peekKind())
      || this.#isErrorIslandBoundary(this.#peekKind())
      || (
        isExpressionStart(this.#peekKind())
        && this.#shouldDeferAdjacentExpressionToList(this.#peekKind())
      )
    ) {
      return undefined;
    }

    const start = left.tokenRange.start;
    const children: StructuralElement[] = [left];
    this.#reportPrimary("SF2008", "Expected an operator.");

    const skipped = this.#skipErrorIsland((kind) => this.#isErrorIslandBoundary(kind));
    if (skipped !== undefined) {
      children.push(skipped);
    }
    return this.#node(CstKind.ErrorExpression, start, children);
  }

  #parseArrayExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#expect(SyntaxKind.OpenBracketToken, children);
    this.#parseSeparatedList(children, {
      context: ParsingContext.ArrayElements,
      separator: SyntaxKind.CommaToken,
      parseElement: () => this.#parseExpression(),
      expectedElementMessage: "Expected an array element.",
      expectedSeparatorMessage: "Expected ',' between array elements.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseBracketToken, children);
    return this.#node(CstKind.ArrayExpression, start, children);
  }

  #parseObjectExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#expect(SyntaxKind.OpenBraceToken, children);
    this.#parseSeparatedList(children, {
      context: ParsingContext.ObjectMembers,
      separator: SyntaxKind.CommaToken,
      parseElement: () => this.#parseObjectMember(),
      expectedElementMessage: "Expected an object member.",
      expectedSeparatorMessage: "Expected ',' between object members.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseBraceToken, children);
    return this.#node(CstKind.ObjectExpression, start, children);
  }

  #parseObjectMember(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    if (this.#peekKind() === SyntaxKind.OpenBracketToken) {
      const keyStart = this.#position;
      const keyChildren: StructuralElement[] = [];
      this.#consume();
      keyChildren.push(this.#withParsingContext(
        ParsingContext.ComputedObjectKey,
        () => this.#parseExpression(),
      ));
      this.#expectClosingDelimiter(SyntaxKind.CloseBracketToken, keyChildren);
      children.push(this.#node(CstKind.ComputedObjectKey, keyStart, keyChildren));
    } else if (this.#peekKind() === SyntaxKind.IdentifierToken
      || this.#peekKind() === SyntaxKind.StringLiteralToken) {
      this.#consume();
    } else {
      this.#report("SF2001", "Expected an identifier, string, or computed object key.");
      if (this.#peekKind() !== SyntaxKind.ColonToken && !this.#isRecoveryBoundary(this.#peekKind())) {
        children.push(this.#skipCurrentToken());
      }
    }

    this.#expect(SyntaxKind.ColonToken, children);
    children.push(this.#parseExpression());
    return this.#node(CstKind.ObjectMember, start, children);
  }

  #parseGroupedExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    children.push(this.#withParsingContext(
      ParsingContext.GroupedExpression,
      () => this.#parseExpression(),
    ));
    this.#expectClosingDelimiter(SyntaxKind.CloseParenToken, children);
    return this.#node(CstKind.GroupedExpression, start, children);
  }

  #parseClosureExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    this.#parseSeparatedList(children, {
      context: ParsingContext.ClosureParameters,
      separator: SyntaxKind.CommaToken,
      parseElement: () => {
        const parameterStart = this.#position;
        const pattern = this.#parsePattern();
        return this.#node(CstKind.ClosureParameter, parameterStart, [pattern]);
      },
      expectedElementMessage: "Expected a closure parameter.",
      expectedSeparatorMessage: "Expected ',' between closure parameters.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseParenToken, children);
    this.#expect(SyntaxKind.ArrowToken, children);
    children.push(this.#parseExpression());
    return this.#node(CstKind.ClosureExpression, start, children);
  }

  #parseBlockExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    this.#expect(SyntaxKind.OpenBraceToken, children);
    this.#parseSeparatedList(children, {
      context: ParsingContext.BlockExpressions,
      separator: SyntaxKind.SemicolonToken,
      parseElement: () => this.#parseExpression(),
      expectedElementMessage: "Expected an expression.",
      expectedSeparatorMessage: "Expected ';' between block expressions.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseBraceToken, children);
    return this.#node(CstKind.BlockExpression, start, children);
  }

  #parseIfExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    children.push(this.#withParsingContext(
      ParsingContext.IfCondition,
      () => this.#parseExpression(),
    ));
    this.#expect(SyntaxKind.ThenKeyword, children);
    children.push(this.#withParsingContext(
      ParsingContext.IfBranch,
      () => this.#parseExpression(),
    ));

    while (this.#peekKind() === SyntaxKind.ElifKeyword) {
      const clauseStart = this.#position;
      const clauseChildren: StructuralElement[] = [];
      this.#consume();
      clauseChildren.push(this.#withParsingContext(
        ParsingContext.IfCondition,
        () => this.#parseExpression(),
      ));
      this.#expect(SyntaxKind.ThenKeyword, clauseChildren);
      clauseChildren.push(this.#withParsingContext(
        ParsingContext.IfBranch,
        () => this.#parseExpression(),
      ));
      children.push(this.#node(CstKind.ElifClause, clauseStart, clauseChildren));
    }

    this.#expect(SyntaxKind.ElseKeyword, children);
    children.push(this.#parseExpression());
    return this.#node(CstKind.IfExpression, start, children);
  }

  #parseLetExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    this.#parseSeparatedList(children, {
      context: ParsingContext.LetBindings,
      separator: SyntaxKind.SemicolonToken,
      parseElement: () => {
        const bindingStart = this.#position;
        const bindingChildren: StructuralElement[] = [this.#parsePattern()];
        this.#expect(SyntaxKind.EqualsToken, bindingChildren);
        bindingChildren.push(this.#parseExpression());
        return this.#node(CstKind.LetBinding, bindingStart, bindingChildren);
      },
      expectedElementMessage: "Expected a let binding.",
      expectedSeparatorMessage: "Expected ';' between let bindings.",
      requireElement: true,
      trailingSeparatorDiagnostic: {
        code: "SF2005",
        message: "Expected a let binding after ';'.",
      },
    });
    this.#expect(SyntaxKind.InKeyword, children);
    children.push(this.#parseExpression());
    return this.#node(CstKind.LetExpression, start, children);
  }

  #parseCallExpression(callee: CstNode): CstNode {
    const start = callee.tokenRange.start;
    const children: StructuralElement[] = [callee];
    this.#consume();
    this.#parseSeparatedList(children, {
      context: ParsingContext.CallArguments,
      separator: SyntaxKind.CommaToken,
      parseElement: () => this.#parseExpression(),
      expectedElementMessage: "Expected a call argument.",
      expectedSeparatorMessage: "Expected ',' between call arguments.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseParenToken, children);
    return this.#node(CstKind.CallExpression, start, children);
  }

  #parseFieldSelector(receiver: CstNode): CstNode {
    const start = receiver.tokenRange.start;
    const children: StructuralElement[] = [receiver];
    this.#consume();
    this.#expect(SyntaxKind.IdentifierToken, children);
    return this.#node(CstKind.FieldSelectorExpression, start, children);
  }

  #parseComputedSelector(receiver: CstNode): CstNode {
    const start = receiver.tokenRange.start;
    const children: StructuralElement[] = [receiver];
    this.#consume();
    children.push(this.#withParsingContext(
      ParsingContext.ComputedSelector,
      () => this.#parseExpression(),
    ));
    this.#expectClosingDelimiter(SyntaxKind.CloseBracketToken, children);
    return this.#node(CstKind.ComputedSelectorExpression, start, children);
  }

  #parseMatchExpression(subject: CstNode): CstNode {
    const start = subject.tokenRange.start;
    const children: StructuralElement[] = [subject];
    this.#consume();

    if (!this.#looksLikeMatchSelection()) {
      children.push(this.#parsePattern());
      return this.#node(CstKind.MatchTestExpression, start, children);
    }

    this.#expect(SyntaxKind.OpenBraceToken, children);
    this.#withParsingContext(ParsingContext.MatchCases, () => {
      let caseCount = 0;
      while (!this.#isListEndForRecovery(ParsingContext.MatchCases, this.#peekKind())) {
        if (this.#peekKind() === SyntaxKind.CaseKeyword) {
          const caseStart = this.#position;
          const caseChildren: StructuralElement[] = [];
          this.#consume();
          caseChildren.push(this.#parsePattern());
          this.#expect(SyntaxKind.ArrowToken, caseChildren);
          caseChildren.push(this.#parseExpression());
          children.push(this.#node(CstKind.MatchCase, caseStart, caseChildren));
          caseCount += 1;
          continue;
        }

        if (this.#recoverUnexpectedTokens(
          ParsingContext.MatchCases,
          children,
          "Expected 'case', 'else', or '}'.",
        ) === RecoveryAction.Abort) {
          break;
        }
      }

      if (caseCount === 0) {
        this.#report("SF2002", "A match selection requires at least one case.");
      }

      if (this.#peekKind() === SyntaxKind.ElseKeyword) {
        const elseStart = this.#position;
        const elseChildren: StructuralElement[] = [];
        this.#consume();
        this.#expect(SyntaxKind.ArrowToken, elseChildren);
        elseChildren.push(this.#parseExpression());
        children.push(this.#node(CstKind.MatchElse, elseStart, elseChildren));
      }
    });

    this.#expectClosingDelimiter(SyntaxKind.CloseBraceToken, children);
    return this.#node(CstKind.MatchSelectionExpression, start, children);
  }

  #parsePattern(): CstNode {
    const start = this.#position;
    const kind = this.#peekKind();
    switch (kind) {
      case SyntaxKind.NumberLiteralToken:
      case SyntaxKind.StringLiteralToken:
      case SyntaxKind.NilKeyword:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        this.#consume();
        return this.#node(CstKind.LiteralPattern, start);
      case SyntaxKind.IdentifierToken: {
        const token = this.#peekToken();
        this.#consume();
        return this.#node(token.value === "_" ? CstKind.WildcardPattern : CstKind.IdentifierPattern, start);
      }
      default: {
        const children: StructuralElement[] = [];
        this.#reportPrimary("SF2003", "Expected a pattern.");
        if (!this.#isRecoveryBoundary(kind) && !this.#isPatternTerminator(kind)) {
          const skipped = this.#skipErrorIsland((candidate) =>
            this.#isErrorIslandBoundary(candidate) || this.#isPatternTerminator(candidate)
          );
          if (skipped !== undefined) {
            children.push(skipped);
          }
        }
        return this.#node(CstKind.ErrorPattern, start, children);
      }
    }
  }

  #parseSeparatedList(children: StructuralElement[], options: SeparatedListOptions): void {
    this.#withParsingContext(options.context, () => {
      let expectsElement = true;
      let parsedElement = false;

      while (!this.#isListEndForRecovery(options.context, this.#peekKind())) {
        const positionBefore = this.#position;
        const expectedElementBefore: boolean = expectsElement;

        if (expectsElement) {
          if (this.#isListElement(options.context, this.#peekKind())) {
            const elementStart = this.#position;
            children.push(options.parseElement());
            if (this.#position === elementStart) {
              this.#report("SF2000", options.expectedElementMessage);
              if (!this.#isRecoveryBoundary(this.#peekKind())) {
                children.push(this.#skipCurrentToken());
              }
            }
            expectsElement = false;
            parsedElement = true;
          } else if (this.#peekKind() === options.separator) {
            this.#report("SF2000", options.expectedElementMessage);
            children.push(this.#skipCurrentToken());
          } else {
            const action = this.#recoverUnexpectedTokens(
              options.context,
              children,
              options.expectedElementMessage,
            );
            if (action === RecoveryAction.Abort) {
              break;
            }
            this.#consumeIf(options.separator);
          }
        } else if (this.#consumeIf(options.separator) !== undefined) {
          expectsElement = true;
          if (
            options.trailingSeparatorDiagnostic !== undefined
            && this.#isListEndForRecovery(options.context, this.#peekKind())
          ) {
            this.#report(
              options.trailingSeparatorDiagnostic.code,
              options.trailingSeparatorDiagnostic.message,
            );
          }
        } else if (this.#isListElement(options.context, this.#peekKind())) {
          children.push(this.#missingToken(options.separator));
          this.#reportExpected(options.separator, options.expectedSeparatorMessage);
          expectsElement = true;
        } else {
          const action = this.#recoverUnexpectedTokens(
            options.context,
            children,
            options.expectedSeparatorMessage,
          );
          if (action === RecoveryAction.Abort) {
            break;
          }
          if (this.#isListElement(options.context, this.#peekKind())) {
            expectsElement = true;
          }
        }

        if (
          this.#position === positionBefore
          && expectsElement === expectedElementBefore
          && !this.#isListEndForRecovery(options.context, this.#peekKind())
        ) {
          this.#report("SF2004", options.expectedElementMessage);
          children.push(this.#skipCurrentToken());
        }
      }

      if (options.requireElement === true && !parsedElement) {
        this.#report("SF2000", options.expectedElementMessage);
      }
    });
  }

  #recoverUnexpectedTokens(
    context: ParsingContext,
    children: StructuralElement[],
    message: string,
  ): RecoveryAction {
    if (
      this.#isListEndForRecovery(context, this.#peekKind())
      || this.#isOuterRecoveryBoundary(this.#peekKind())
    ) {
      return RecoveryAction.Abort;
    }

    const tokenAlreadyDiagnosed = this.#currentTokenHasDiagnostic();
    this.#reportPrimary("SF2004", message);

    const skipped = tokenAlreadyDiagnosed
      ? this.#skipErrorIsland((kind) => this.#isErrorIslandBoundary(kind))
      : this.#skipTokensWhile((token) =>
          !this.#isListElement(context, token.kind)
          && !this.#isListEndForRecovery(context, token.kind)
          && token.kind !== this.#separatorForContext(context)
          && !this.#isOuterRecoveryBoundary(token.kind)
        );
    if (skipped === undefined) {
      return RecoveryAction.Abort;
    }

    children.push(skipped);
    return RecoveryAction.Continue;
  }

  #withParsingContext<T>(context: ParsingContext, action: () => T): T {
    this.#parsingContexts.push(context);
    try {
      return action();
    } finally {
      const popped = this.#parsingContexts.pop();
      if (popped !== context) {
        throw new Error("Parser recovery context stack is unbalanced.");
      }
    }
  }

  #isListElement(context: ParsingContext, kind: SyntaxKind): boolean {
    switch (context) {
      case ParsingContext.ProgramExpressions:
      case ParsingContext.ArrayElements:
      case ParsingContext.BlockExpressions:
      case ParsingContext.CallArguments:
        return isExpressionStart(kind);
      case ParsingContext.ObjectMembers:
        return isObjectMemberStart(kind);
      case ParsingContext.ClosureParameters:
      case ParsingContext.LetBindings:
        return isPatternStart(kind);
      case ParsingContext.MatchCases:
        return kind === SyntaxKind.CaseKeyword;
      case ParsingContext.GroupedExpression:
      case ParsingContext.ComputedObjectKey:
      case ParsingContext.ComputedSelector:
      case ParsingContext.IfCondition:
      case ParsingContext.IfBranch:
        return false;
    }
  }

  #isListTerminator(context: ParsingContext, kind: SyntaxKind): boolean {
    if (kind === SyntaxKind.EndOfFileToken) {
      return true;
    }

    switch (context) {
      case ParsingContext.ProgramExpressions:
        return false;
      case ParsingContext.ArrayElements:
        return kind === SyntaxKind.CloseBracketToken;
      case ParsingContext.ObjectMembers:
      case ParsingContext.BlockExpressions:
        return kind === SyntaxKind.CloseBraceToken;
      case ParsingContext.ClosureParameters:
        return kind === SyntaxKind.CloseParenToken || kind === SyntaxKind.ArrowToken;
      case ParsingContext.CallArguments:
      case ParsingContext.GroupedExpression:
        return kind === SyntaxKind.CloseParenToken;
      case ParsingContext.LetBindings:
        return kind === SyntaxKind.InKeyword;
      case ParsingContext.MatchCases:
        return kind === SyntaxKind.ElseKeyword || kind === SyntaxKind.CloseBraceToken;
      case ParsingContext.ComputedObjectKey:
      case ParsingContext.ComputedSelector:
        return kind === SyntaxKind.CloseBracketToken;
      case ParsingContext.IfCondition:
        return kind === SyntaxKind.ThenKeyword;
      case ParsingContext.IfBranch:
        return kind === SyntaxKind.ElifKeyword || kind === SyntaxKind.ElseKeyword;
    }
  }

  #isListEndForRecovery(context: ParsingContext, kind: SyntaxKind): boolean {
    return this.#isListTerminator(context, kind)
      || (
        this.#expectedClosingDelimiter(context) !== undefined
        && isClosingDelimiter(kind)
      );
  }

  #expectedClosingDelimiter(context: ParsingContext): SyntaxKind | undefined {
    switch (context) {
      case ParsingContext.ArrayElements:
      case ParsingContext.ComputedObjectKey:
      case ParsingContext.ComputedSelector:
        return SyntaxKind.CloseBracketToken;
      case ParsingContext.ObjectMembers:
      case ParsingContext.BlockExpressions:
      case ParsingContext.MatchCases:
        return SyntaxKind.CloseBraceToken;
      case ParsingContext.ClosureParameters:
      case ParsingContext.CallArguments:
      case ParsingContext.GroupedExpression:
        return SyntaxKind.CloseParenToken;
      case ParsingContext.ProgramExpressions:
      case ParsingContext.LetBindings:
      case ParsingContext.IfCondition:
      case ParsingContext.IfBranch:
        return undefined;
    }
  }

  #separatorForContext(context: ParsingContext): SyntaxKind | undefined {
    switch (context) {
      case ParsingContext.ProgramExpressions:
      case ParsingContext.BlockExpressions:
      case ParsingContext.LetBindings:
        return SyntaxKind.SemicolonToken;
      case ParsingContext.ArrayElements:
      case ParsingContext.ObjectMembers:
      case ParsingContext.ClosureParameters:
      case ParsingContext.CallArguments:
        return SyntaxKind.CommaToken;
      case ParsingContext.MatchCases:
      case ParsingContext.GroupedExpression:
      case ParsingContext.ComputedObjectKey:
      case ParsingContext.ComputedSelector:
      case ParsingContext.IfCondition:
      case ParsingContext.IfBranch:
        return undefined;
    }
  }

  #isRecoveryBoundary(kind: SyntaxKind): boolean {
    return this.#parsingContexts.some((context) => this.#isContextBoundary(context, kind, true));
  }

  #isErrorIslandBoundary(kind: SyntaxKind): boolean {
    return this.#parsingContexts.some((context) => this.#isContextBoundary(context, kind, false));
  }

  #isContextBoundary(
    context: ParsingContext,
    kind: SyntaxKind,
    includeMismatchedCloser: boolean,
  ): boolean {
    return this.#isListTerminator(context, kind)
      || this.#separatorForContext(context) === kind
      || (context === ParsingContext.MatchCases && this.#isListElement(context, kind))
      || (
        includeMismatchedCloser
        && this.#expectedClosingDelimiter(context) !== undefined
        && isClosingDelimiter(kind)
      );
  }

  #shouldDeferAdjacentExpressionToList(kind: SyntaxKind): boolean {
    const context = this.#parsingContexts.at(-1);
    switch (context) {
      case ParsingContext.ProgramExpressions:
      case ParsingContext.ArrayElements:
      case ParsingContext.BlockExpressions:
      case ParsingContext.CallArguments:
        return isExpressionStart(kind);
      case ParsingContext.ObjectMembers:
        return isObjectMemberStart(kind);
      case ParsingContext.LetBindings:
        return isPatternStart(kind) && this.#peekKindAfterCurrent() === SyntaxKind.EqualsToken;
      case ParsingContext.ClosureParameters:
      case ParsingContext.MatchCases:
      case ParsingContext.GroupedExpression:
      case ParsingContext.ComputedObjectKey:
      case ParsingContext.ComputedSelector:
      case ParsingContext.IfCondition:
      case ParsingContext.IfBranch:
      case undefined:
        return false;
    }
  }

  #isOuterRecoveryBoundary(kind: SyntaxKind): boolean {
    for (let index = 0; index < this.#parsingContexts.length - 1; index += 1) {
      const context = this.#parsingContexts[index];
      if (
        context !== undefined
        && this.#isContextBoundary(context, kind, true)
      ) {
        return true;
      }
    }
    return false;
  }

  #looksLikeClosure(): boolean {
    let cursor = this.#nextSignificantIndex(this.#position);
    if (this.#tokens[cursor]?.kind !== SyntaxKind.OpenParenToken) {
      return false;
    }
    let depth = 0;
    while (cursor < this.#tokens.length) {
      const kind = this.#tokens[cursor]?.kind;
      if (kind === SyntaxKind.OpenParenToken) {
        depth += 1;
      } else if (kind === SyntaxKind.CloseParenToken) {
        depth -= 1;
        if (depth === 0) {
          cursor = this.#nextSignificantIndex(cursor + 1);
          return this.#tokens[cursor]?.kind === SyntaxKind.ArrowToken;
        }
      } else if (kind === SyntaxKind.ArrowToken && depth === 1) {
        return true;
      } else if (kind === SyntaxKind.EndOfFileToken) {
        return false;
      }
      cursor = this.#nextSignificantIndex(cursor + 1);
    }
    return false;
  }

  #peekKindAfterCurrent(): SyntaxKind {
    const current = this.#nextSignificantIndex(this.#position);
    return this.#tokens[this.#nextSignificantIndex(current + 1)]?.kind ?? SyntaxKind.EndOfFileToken;
  }

  #looksLikeMisspelledLetExpression(): boolean {
    const keyword = this.#peekSignificantToken(0);
    const pattern = this.#peekSignificantToken(1);
    const equals = this.#peekSignificantToken(2);
    return keyword.kind === SyntaxKind.IdentifierToken
      && isSingleEditAway(keyword.value ?? "", "let")
      && isPatternStart(pattern.kind)
      && equals.kind === SyntaxKind.EqualsToken;
  }

  #peekSignificantToken(offset: number): SyntaxToken {
    let index = this.#nextSignificantIndex(this.#position);
    for (let current = 0; current < offset; current += 1) {
      if (this.#tokens[index]?.kind === SyntaxKind.EndOfFileToken) {
        break;
      }
      index = this.#nextSignificantIndex(index + 1);
    }
    const token = this.#tokens[index];
    if (token === undefined) {
      throw new Error("Parser token stream is missing its EOF token.");
    }
    return token;
  }

  #looksLikeMatchSelection(): boolean {
    let cursor = this.#nextSignificantIndex(this.#position);
    let kind = this.#tokens[cursor]?.kind;
    if (
      kind === SyntaxKind.OpenBraceToken
      || kind === SyntaxKind.CaseKeyword
      || kind === SyntaxKind.ElseKeyword
    ) {
      return true;
    }

    while (
      kind !== undefined
      && kind !== SyntaxKind.EndOfFileToken
      && (this.#tokens[cursor]?.flags ?? TokenFlags.None) !== TokenFlags.None
    ) {
      cursor = this.#nextSignificantIndex(cursor + 1);
      kind = this.#tokens[cursor]?.kind;
    }
    return kind === SyntaxKind.OpenBraceToken
      || kind === SyntaxKind.CaseKeyword
      || kind === SyntaxKind.ElseKeyword;
  }

  #binaryOperator(): {
    readonly precedence: number;
    readonly nodeKind: CstKind.InfixOperatorExpression | CstKind.InfixCallExpression;
    readonly recoveryDiagnostic?: string;
  } | undefined {
    switch (this.#peekKind()) {
      case SyntaxKind.OrKeyword:
        return { precedence: Precedence.Or, nodeKind: CstKind.InfixOperatorExpression };
      case SyntaxKind.BarBarToken:
        return {
          precedence: Precedence.Or,
          nodeKind: CstKind.InfixOperatorExpression,
          recoveryDiagnostic: "'||' is not a logical operator. Use 'or' instead.",
        };
      case SyntaxKind.AndKeyword:
        return { precedence: Precedence.And, nodeKind: CstKind.InfixOperatorExpression };
      case SyntaxKind.AmpersandAmpersandToken:
        return {
          precedence: Precedence.And,
          nodeKind: CstKind.InfixOperatorExpression,
          recoveryDiagnostic: "'&&' is not a logical operator. Use 'and' instead.",
        };
      case SyntaxKind.EqualsEqualsToken:
      case SyntaxKind.BangEqualsToken:
        return { precedence: Precedence.Equality, nodeKind: CstKind.InfixOperatorExpression };
      case SyntaxKind.LessThanToken:
      case SyntaxKind.LessThanEqualsToken:
      case SyntaxKind.GreaterThanToken:
      case SyntaxKind.GreaterThanEqualsToken:
        return { precedence: Precedence.Comparison, nodeKind: CstKind.InfixOperatorExpression };
      case SyntaxKind.PlusToken:
      case SyntaxKind.MinusToken:
        return { precedence: Precedence.Additive, nodeKind: CstKind.InfixOperatorExpression };
      case SyntaxKind.AsteriskToken:
      case SyntaxKind.SlashToken:
      case SyntaxKind.PercentToken:
        return { precedence: Precedence.Multiplicative, nodeKind: CstKind.InfixOperatorExpression };
      case SyntaxKind.IdentifierToken:
        return { precedence: Precedence.InfixCall, nodeKind: CstKind.InfixCallExpression };
      default:
        return undefined;
    }
  }

  #expect(kind: SyntaxKind, children: StructuralElement[]): SyntaxToken | undefined {
    const token = this.#consumeIf(kind);
    if (token !== undefined) {
      return token;
    }

    if (this.#peekToken().flags !== TokenFlags.None && !this.#isRecoveryBoundary(this.#peekKind())) {
      const skipped = this.#skipTokensWhile((candidate) =>
        candidate.flags !== TokenFlags.None && !this.#isRecoveryBoundary(candidate.kind)
      );
      if (skipped === undefined) {
        throw new Error("Lexically invalid token recovery made no progress.");
      }
      const recovered = this.#consumeIf(kind);
      if (recovered !== undefined) {
        children.push(skipped);
        return recovered;
      }
      children.push(this.#missingToken(kind), skipped);
      return undefined;
    }

    children.push(this.#missingToken(kind));
    if (!this.#currentTokenHasDiagnostic()) {
      this.#reportExpected(kind, `Expected ${displayToken(kind)}.`);
    }
    return undefined;
  }

  #expectClosingDelimiter(
    kind: SyntaxKind,
    children: StructuralElement[],
  ): SyntaxToken | undefined {
    const token = this.#consumeIf(kind);
    if (token !== undefined) {
      return token;
    }

    if (isClosingDelimiter(this.#peekKind()) && !this.#isRecoveryBoundary(this.#peekKind())) {
      children.push(this.#missingToken(kind));
      this.#reportPrimary("SF2004", `Expected ${displayToken(kind)}.`);
      children.push(this.#skipCurrentToken());
      return undefined;
    }

    return this.#expect(kind, children);
  }

  #consumeIf(kind: SyntaxKind): SyntaxToken | undefined {
    if (this.#peekKind() !== kind) {
      return undefined;
    }
    return this.#consume();
  }

  #consume(): SyntaxToken {
    const index = this.#nextSignificantIndex(this.#position);
    const token = this.#tokens[index];
    if (token === undefined) {
      throw new Error("Parser token stream is missing its EOF token.");
    }
    this.#position = index + 1;
    return token;
  }

  #peekToken(): SyntaxToken {
    const token = this.#tokens[this.#nextSignificantIndex(this.#position)];
    if (token === undefined) {
      throw new Error("Parser token stream is missing its EOF token.");
    }
    return token;
  }

  #peekKind(): SyntaxKind {
    return this.#peekToken().kind;
  }

  #currentTokenHasDiagnostic(): boolean {
    return this.#diagnosticStarts.has(this.#peekToken().range.start);
  }

  #skipTokensWhile(predicate: (token: SyntaxToken) => boolean): CstSkippedTokens | undefined {
    const start = this.#position;
    while (this.#peekKind() !== SyntaxKind.EndOfFileToken && predicate(this.#peekToken())) {
      this.#consume();
    }
    return this.#position === start ? undefined : this.#skippedTokens(start, this.#position);
  }

  // A malformed region owns everything up to the nearest enclosing grammar
  // boundary. Balanced nested delimiters do not expose their separators to the
  // enclosing construct, while control keywords remain hard synchronization points.
  #skipErrorIsland(isBoundary: (kind: SyntaxKind) => boolean): CstSkippedTokens | undefined {
    const start = this.#position;
    const expectedClosers: SyntaxKind[] = [];

    while (this.#peekKind() !== SyntaxKind.EndOfFileToken) {
      const kind = this.#peekKind();
      if (
        isBoundary(kind)
        && (expectedClosers.length === 0 || isKeywordRecoveryBoundary(kind))
      ) {
        break;
      }

      const closer = closingDelimiterFor(kind);
      if (closer !== undefined) {
        expectedClosers.push(closer);
      } else if (expectedClosers.at(-1) === kind) {
        expectedClosers.pop();
      }
      this.#consume();
    }

    return this.#position === start ? undefined : this.#skippedTokens(start, this.#position);
  }

  #nextSignificantIndex(from: number): number {
    let index = from;
    while (isTriviaKind(this.#tokens[index]?.kind ?? SyntaxKind.EndOfFileToken)) {
      index += 1;
    }
    return index;
  }

  #node(kind: CstNode["kind"], start: number, structure: readonly StructuralElement[] = []): CstNode {
    const end = this.#position;
    const ordered = [...structure].sort((left, right) => {
      const leftStart = elementTokenStart(left);
      const rightStart = elementTokenStart(right);
      return leftStart - rightStart;
    });
    const children: CstElement[] = [];
    let cursor = start;

    for (const element of ordered) {
      const elementStart = elementTokenStart(element);
      const elementEnd = elementTokenEnd(element);
      if (elementStart < cursor || elementEnd > end) {
        throw new Error(`Invalid CST nesting while building ${kind}.`);
      }
      while (cursor < elementStart) {
        const token = this.#tokens[cursor];
        if (token !== undefined) {
          children.push(token);
        }
        cursor += 1;
      }
      children.push(element);
      cursor = elementEnd;
    }

    while (cursor < end) {
      const token = this.#tokens[cursor];
      if (token !== undefined) {
        children.push(token);
      }
      cursor += 1;
    }

    return {
      type: "node",
      kind,
      range: this.#significantRangeForTokenRange(start, end),
      fullRange: this.#fullRangeForTokenRange(start, end),
      tokenRange: textRange(start, end),
      children,
    };
  }

  #missingToken(expectedKind: SyntaxKind): CstMissingToken {
    const index = this.#nextSignificantIndex(this.#position);
    const offset = this.#tokens[index]?.range.start ?? this.#source.length;
    return {
      type: "missing-token",
      expectedKind,
      range: textRange(offset, offset),
      tokenIndex: this.#position,
    };
  }

  #skipCurrentToken(): CstSkippedTokens {
    const start = this.#position;
    this.#consume();
    return this.#skippedTokens(start, this.#position);
  }

  #skipExpressionAtDepthLimit(): CstSkippedTokens {
    const start = this.#position;
    const expectedClosers: SyntaxKind[] = [];

    do {
      const kind = this.#peekKind();
      const closer = closingDelimiterFor(kind);
      if (closer !== undefined) {
        expectedClosers.push(closer);
      } else if (isClosingDelimiter(kind)) {
        if (expectedClosers.at(-1) === kind) {
          expectedClosers.pop();
        } else if (expectedClosers.length === 0) {
          break;
        }
      }

      this.#consume();
      if (expectedClosers.length === 0) {
        break;
      }
    } while (this.#peekKind() !== SyntaxKind.EndOfFileToken);

    if (this.#position === start) {
      return this.#skipCurrentToken();
    }
    return this.#skippedTokens(start, this.#position);
  }

  #skippedTokens(start: number, end: number): CstSkippedTokens {
    if (end <= start) {
      throw new Error("Skipped token ranges must contain at least one token.");
    }
    return {
      type: "skipped-tokens",
      range: this.#significantRangeForTokenRange(start, end),
      fullRange: this.#fullRangeForTokenRange(start, end),
      tokenRange: textRange(start, end),
      tokens: this.#tokens.slice(start, end),
    };
  }

  #fullRangeForTokenRange(start: number, end: number) {
    const startOffset = this.#tokens[start]?.range.start ?? this.#source.length;
    const endOffset = end > start
      ? (this.#tokens[end - 1]?.range.end ?? startOffset)
      : startOffset;
    return textRange(startOffset, endOffset);
  }

  #significantRangeForTokenRange(start: number, end: number) {
    let first = start;
    while (first < end && isTriviaOrEof(this.#tokens[first])) {
      first += 1;
    }

    let last = end - 1;
    while (last >= first && isTriviaOrEof(this.#tokens[last])) {
      last -= 1;
    }

    if (first >= end || last < first) {
      const offset = this.#tokens[this.#nextSignificantIndex(start)]?.range.start ?? this.#source.length;
      return textRange(offset, offset);
    }

    const firstToken = this.#tokens[first];
    const lastToken = this.#tokens[last];
    return textRange(
      firstToken?.range.start ?? this.#source.length,
      lastToken?.range.end ?? this.#source.length,
    );
  }

  #reportExpected(expected: SyntaxKind, message: string): void {
    const range = this.#peekToken().range;
    this.#addDiagnostic(diagnostic("SF2004", "parse", message, textRange(range.start, range.start)));
  }

  #report(code: DiagnosticCode, message: string): void {
    const token = this.#peekToken();
    const range = token.kind === SyntaxKind.EndOfFileToken
      ? textRange(token.range.start, token.range.start)
      : token.range;
    this.#addDiagnostic(diagnostic(code, "parse", message, range));
  }

  #reportPrimary(code: DiagnosticCode, message: string): void {
    if (!this.#currentTokenHasDiagnostic()) {
      this.#report(code, message);
    }
  }

  #reportMisspelledKeyword(expected: string): void {
    const token = this.#peekToken();
    this.#addDiagnostic(diagnostic(
      "SF2009",
      "parse",
      `'${token.value ?? ""}' is not valid before a binding. Did you mean '${expected}'?`,
      token.range,
    ));
  }

  #addDiagnostic(value: Diagnostic): void {
    const key = diagnosticKey(value);
    if (this.#diagnosticKeys.has(key)) {
      return;
    }
    this.#diagnosticKeys.add(key);
    this.#diagnosticStarts.add(value.range.start);
    this.#diagnostics.push(value);
  }

  #isPatternTerminator(kind: SyntaxKind): boolean {
    return kind === SyntaxKind.EqualsToken
      || kind === SyntaxKind.ArrowToken
      || kind === SyntaxKind.CommaToken
      || kind === SyntaxKind.CloseParenToken
      || kind === SyntaxKind.EndOfFileToken;
  }
}

function elementTokenStart(element: StructuralElement): number {
  return element.type === "missing-token" ? element.tokenIndex : element.tokenRange.start;
}

function elementTokenEnd(element: StructuralElement): number {
  return element.type === "missing-token" ? element.tokenIndex : element.tokenRange.end;
}

function isPatternStart(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.IdentifierToken
    || kind === SyntaxKind.NumberLiteralToken
    || kind === SyntaxKind.StringLiteralToken
    || kind === SyntaxKind.NilKeyword
    || kind === SyntaxKind.TrueKeyword
    || kind === SyntaxKind.FalseKeyword;
}

function isExpressionStart(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.NumberLiteralToken
    || kind === SyntaxKind.StringLiteralToken
    || kind === SyntaxKind.NilKeyword
    || kind === SyntaxKind.TrueKeyword
    || kind === SyntaxKind.FalseKeyword
    || kind === SyntaxKind.IdentifierToken
    || kind === SyntaxKind.OpenBracketToken
    || kind === SyntaxKind.OpenBraceToken
    || kind === SyntaxKind.OpenParenToken
    || kind === SyntaxKind.DoKeyword
    || kind === SyntaxKind.IfKeyword
    || kind === SyntaxKind.LetKeyword
    || kind === SyntaxKind.MinusToken
    || kind === SyntaxKind.NotKeyword;
}

function isObjectMemberStart(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.IdentifierToken
    || kind === SyntaxKind.StringLiteralToken
    || kind === SyntaxKind.OpenBracketToken;
}

function isClosingDelimiter(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.CloseParenToken
    || kind === SyntaxKind.CloseBracketToken
    || kind === SyntaxKind.CloseBraceToken;
}

function isKeywordRecoveryBoundary(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.ThenKeyword
    || kind === SyntaxKind.ElifKeyword
    || kind === SyntaxKind.ElseKeyword
    || kind === SyntaxKind.InKeyword
    || kind === SyntaxKind.CaseKeyword;
}

function closingDelimiterFor(kind: SyntaxKind | undefined): SyntaxKind | undefined {
  switch (kind) {
    case SyntaxKind.OpenParenToken:
      return SyntaxKind.CloseParenToken;
    case SyntaxKind.OpenBracketToken:
      return SyntaxKind.CloseBracketToken;
    case SyntaxKind.OpenBraceToken:
      return SyntaxKind.CloseBraceToken;
    default:
      return undefined;
  }
}

function displayToken(kind: SyntaxKind): string {
  return tokenDisplayText.get(kind) ?? `token ${kind}`;
}

function isTriviaOrEof(token: SyntaxToken | undefined): boolean {
  return token === undefined || isTriviaKind(token.kind) || token.kind === SyntaxKind.EndOfFileToken;
}

function diagnosticKey(value: Diagnostic): string {
  return `${value.code}:${value.range.start}:${value.range.end}:${value.message}`;
}

function isSingleEditAway(actual: string, expected: string): boolean {
  if (actual === expected || Math.abs(actual.length - expected.length) > 1) {
    return false;
  }

  if (actual.length === expected.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < actual.length; index += 1) {
      if (actual[index] !== expected[index]) {
        mismatches.push(index);
      }
    }
    return mismatches.length === 1
      || (
        mismatches.length === 2
        && mismatches[1] === (mismatches[0] ?? 0) + 1
        && actual[mismatches[0] ?? 0] === expected[mismatches[1] ?? 0]
        && actual[mismatches[1] ?? 0] === expected[mismatches[0] ?? 0]
      );
  }

  const shorter = actual.length < expected.length ? actual : expected;
  const longer = actual.length < expected.length ? expected : actual;
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      longerIndex += 1;
    }
  }
  return true;
}

const tokenDisplayText = new Map<SyntaxKind, string>([
  [SyntaxKind.OpenParenToken, "'('"],
  [SyntaxKind.CloseParenToken, "')'"],
  [SyntaxKind.OpenBracketToken, "'['"],
  [SyntaxKind.CloseBracketToken, "']'"],
  [SyntaxKind.OpenBraceToken, "'{'"],
  [SyntaxKind.CloseBraceToken, "'}'"],
  [SyntaxKind.CommaToken, "','"],
  [SyntaxKind.SemicolonToken, "';'"],
  [SyntaxKind.ColonToken, "':'"],
  [SyntaxKind.ArrowToken, "'->'"],
  [SyntaxKind.EqualsToken, "'='"],
  [SyntaxKind.ThenKeyword, "'then'"],
  [SyntaxKind.ElseKeyword, "'else'"],
  [SyntaxKind.InKeyword, "'in'"],
  [SyntaxKind.IdentifierToken, "an identifier"],
]);
