import {
  CstKind,
  type CstElement,
  type CstMissingToken,
  type CstNode,
  type CstSkippedTokens,
} from "./cst.js";
import { diagnostic, sortDiagnostics, type Diagnostic, type DiagnosticCode } from "./diagnostic.js";
import { lex } from "./lexer.js";
import { SyntaxKind } from "./syntax-kind.js";
import { SourceText, textRange } from "./text.js";
import { tokenFullRange, TokenFlags, type SyntaxToken } from "./token.js";

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
  ProgramStatements,
  BlockStatements,
  ArrayElements,
  DictionaryEntries,
  ClosureParameters,
  CallArguments,
  MatchCases,
  GroupedExpression,
  ComputedDictionaryKey,
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

    this.#parseStatementList(children, ParsingContext.ProgramStatements, false);

    this.#consumeIf(SyntaxKind.EndOfFileToken);
    const cst = this.#node(CstKind.Program, start, children);
    return {
      source: this.#source,
      tokens: this.#tokens,
      cst,
      diagnostics: sortDiagnostics(this.#diagnostics),
    };
  }

  #parseStatementList(
    children: StructuralElement[],
    context: ParsingContext.ProgramStatements | ParsingContext.BlockStatements,
    allowResult: boolean,
  ): void {
    this.#withParsingContext(context, () => {
      while (!this.#isListEndForRecovery(context, this.#peekKind())) {
        const start = this.#position;

        if (this.#peekKind() === SyntaxKind.SemicolonToken) {
          this.#consume();
          children.push(this.#node(CstKind.EmptyStatement, start));
          continue;
        }

        if (!isStatementStart(this.#peekKind())) {
          if (this.#recoverUnexpectedTokens(
            context,
            children,
            "Expected a statement.",
          ) === RecoveryAction.Abort) {
            break;
          }
          continue;
        }

        if (this.#peekKind() === SyntaxKind.LetKeyword) {
          children.push(this.#parseLetStatement());
        } else if (this.#peekKind() === SyntaxKind.FnKeyword) {
          children.push(this.#parseFnStatement());
        } else {
          const expression = this.#parseExpression();
          if (
            allowResult
            && this.#peekKind() !== SyntaxKind.SemicolonToken
            && this.#isListEndForRecovery(context, this.#peekKind())
          ) {
            children.push(expression);
            break;
          }

          const statementChildren: StructuralElement[] = [expression];
          this.#expectStatementTerminator(statementChildren);
          children.push(this.#node(CstKind.ExpressionStatement, start, statementChildren));
        }

        if (this.#position === start) {
          this.#reportPrimary("SF2004", "Expected a statement.");
          children.push(this.#skipCurrentToken());
        }
      }
    });
  }

  #parseLetStatement(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    children.push(this.#parsePattern());
    this.#expect(SyntaxKind.EqualsToken, children);
    children.push(this.#parseExpression());
    this.#expectStatementTerminator(children);
    return this.#node(CstKind.LetStatement, start, children);
  }

  #parseFnStatement(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    this.#expect(SyntaxKind.IdentifierToken, children);
    this.#expect(SyntaxKind.OpenParenToken, children);
    this.#parseSeparatedList(children, {
      context: ParsingContext.ClosureParameters,
      separator: SyntaxKind.CommaToken,
      parseElement: () => {
        const parameterStart = this.#position;
        return this.#node(CstKind.ClosureParameter, parameterStart, [this.#parsePattern()]);
      },
      expectedElementMessage: "Expected a function parameter.",
      expectedSeparatorMessage: "Expected ',' between function parameters.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseParenToken, children);
    this.#expect(SyntaxKind.EqualsToken, children);
    children.push(this.#parseExpression());
    this.#expectStatementTerminator(children);
    return this.#node(CstKind.FnStatement, start, children);
  }

  #expectStatementTerminator(children: StructuralElement[]): void {
    if (this.#consumeIf(SyntaxKind.SemicolonToken) !== undefined) {
      return;
    }
    children.push(this.#missingToken(SyntaxKind.SemicolonToken));
    this.#reportExpected(SyntaxKind.SemicolonToken, "Expected ';' after the statement.");
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
    if (minimumPrecedence === Precedence.Lowest && this.#looksLikeBareClosure()) {
      return this.#parseBareClosureExpression();
    }

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
      if (postfix === SyntaxKind.OpenBraceToken) {
        left = this.#parseTrailingBraceCall(left);
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
        this.#consume();
        return this.#node(CstKind.IdentifierExpression, start);
      case SyntaxKind.OpenBracketToken:
        return this.#parseArrayExpression();
      case SyntaxKind.OpenBraceToken:
        return this.#parseBraceExpression();
      case SyntaxKind.OpenParenToken:
        return this.#looksLikeClosure() ? this.#parseClosureExpression() : this.#parseGroupedExpression();
      case SyntaxKind.IfKeyword:
        return this.#parseIfExpression();
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
      || this.#shouldDeferAdjacentExpressionToList(this.#peekKind())
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

  #parseBraceExpression(): CstNode {
    return this.#looksLikeDictionaryExpression()
      ? this.#parseDictionaryExpression()
      : this.#parseBlockExpression();
  }

  #parseDictionaryExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#expect(SyntaxKind.OpenBraceToken, children);
    this.#parseSeparatedList(children, {
      context: ParsingContext.DictionaryEntries,
      separator: SyntaxKind.CommaToken,
      parseElement: () => this.#parseDictionaryEntry(),
      expectedElementMessage: "Expected a dictionary entry.",
      expectedSeparatorMessage: "Expected ',' between dictionary entries.",
    });
    this.#expectClosingDelimiter(SyntaxKind.CloseBraceToken, children);
    return this.#node(CstKind.DictionaryExpression, start, children);
  }

  #parseDictionaryEntry(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    if (
      this.#peekKind() === SyntaxKind.IdentifierToken
      && this.#peekKindAfterCurrent() !== SyntaxKind.ColonToken
    ) {
      this.#consume();
      return this.#node(CstKind.ShorthandDictionaryEntry, start);
    }

    if (this.#peekKind() === SyntaxKind.OpenBracketToken) {
      const keyStart = this.#position;
      const keyChildren: StructuralElement[] = [];
      this.#consume();
      keyChildren.push(this.#withParsingContext(
        ParsingContext.ComputedDictionaryKey,
        () => this.#parseExpression(),
      ));
      this.#expectClosingDelimiter(SyntaxKind.CloseBracketToken, keyChildren);
      children.push(this.#node(CstKind.ComputedDictionaryKey, keyStart, keyChildren));
    } else if (this.#peekKind() === SyntaxKind.IdentifierToken
      || this.#peekKind() === SyntaxKind.StringLiteralToken
      || this.#peekKind() === SyntaxKind.NumberLiteralToken) {
      this.#consume();
    } else {
      this.#report("SF2001", "Expected an identifier, literal, or computed dictionary key.");
      if (this.#peekKind() !== SyntaxKind.ColonToken && !this.#isRecoveryBoundary(this.#peekKind())) {
        children.push(this.#skipCurrentToken());
      }
    }

    this.#expect(SyntaxKind.ColonToken, children);
    children.push(this.#parseExpression());
    return this.#node(CstKind.DictionaryEntry, start, children);
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

  #parseBareClosureExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    const parameterStart = this.#position;
    children.push(this.#node(CstKind.ClosureParameter, parameterStart, [this.#parsePattern()]));
    this.#expect(SyntaxKind.ArrowToken, children);
    children.push(this.#parseExpression());
    return this.#node(CstKind.ClosureExpression, start, children);
  }

  #parseBlockExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#expect(SyntaxKind.OpenBraceToken, children);
    this.#parseStatementList(children, ParsingContext.BlockStatements, true);
    this.#expectClosingDelimiter(SyntaxKind.CloseBraceToken, children);
    return this.#node(CstKind.BlockExpression, start, children);
  }

  #parseIfExpression(): CstNode {
    const start = this.#position;
    const children: StructuralElement[] = [];
    this.#consume();
    this.#expect(SyntaxKind.OpenParenToken, children);
    children.push(this.#withParsingContext(
      ParsingContext.IfCondition,
      () => this.#parseExpression(),
    ));
    this.#expectClosingDelimiter(SyntaxKind.CloseParenToken, children);
    children.push(this.#withParsingContext(
      ParsingContext.IfBranch,
      () => this.#parseExpression(),
    ));

    if (this.#peekKind() === SyntaxKind.ElseKeyword) {
      this.#consume();
      children.push(this.#parseExpression());
    }
    return this.#node(CstKind.IfExpression, start, children);
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

  #parseTrailingBraceCall(callee: CstNode): CstNode {
    const start = callee.tokenRange.start;
    const argument = this.#parseBraceExpression();
    return this.#node(CstKind.CallExpression, start, [callee, argument]);
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
      case ParsingContext.ProgramStatements:
      case ParsingContext.BlockStatements:
        return isStatementStart(kind);
      case ParsingContext.ArrayElements:
      case ParsingContext.CallArguments:
        return isExpressionStart(kind);
      case ParsingContext.DictionaryEntries:
        return isDictionaryEntryStart(kind);
      case ParsingContext.ClosureParameters:
        return isPatternStart(kind);
      case ParsingContext.MatchCases:
        return kind === SyntaxKind.CaseKeyword;
      case ParsingContext.GroupedExpression:
      case ParsingContext.ComputedDictionaryKey:
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
      case ParsingContext.ProgramStatements:
        return false;
      case ParsingContext.BlockStatements:
        return kind === SyntaxKind.CloseBraceToken;
      case ParsingContext.ArrayElements:
        return kind === SyntaxKind.CloseBracketToken;
      case ParsingContext.DictionaryEntries:
        return kind === SyntaxKind.CloseBraceToken;
      case ParsingContext.ClosureParameters:
        return kind === SyntaxKind.CloseParenToken
          || kind === SyntaxKind.ArrowToken
          || kind === SyntaxKind.EqualsToken;
      case ParsingContext.CallArguments:
      case ParsingContext.GroupedExpression:
        return kind === SyntaxKind.CloseParenToken;
      case ParsingContext.MatchCases:
        return kind === SyntaxKind.ElseKeyword || kind === SyntaxKind.CloseBraceToken;
      case ParsingContext.ComputedDictionaryKey:
      case ParsingContext.ComputedSelector:
        return kind === SyntaxKind.CloseBracketToken;
      case ParsingContext.IfCondition:
        return kind === SyntaxKind.CloseParenToken;
      case ParsingContext.IfBranch:
        return kind === SyntaxKind.ElseKeyword;
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
      case ParsingContext.ComputedDictionaryKey:
      case ParsingContext.ComputedSelector:
        return SyntaxKind.CloseBracketToken;
      case ParsingContext.DictionaryEntries:
      case ParsingContext.BlockStatements:
      case ParsingContext.MatchCases:
        return SyntaxKind.CloseBraceToken;
      case ParsingContext.ClosureParameters:
      case ParsingContext.CallArguments:
      case ParsingContext.GroupedExpression:
        return SyntaxKind.CloseParenToken;
      case ParsingContext.ProgramStatements:
      case ParsingContext.IfCondition:
      case ParsingContext.IfBranch:
        return undefined;
    }
  }

  #separatorForContext(context: ParsingContext): SyntaxKind | undefined {
    switch (context) {
      case ParsingContext.ProgramStatements:
      case ParsingContext.BlockStatements:
        return SyntaxKind.SemicolonToken;
      case ParsingContext.ArrayElements:
      case ParsingContext.DictionaryEntries:
      case ParsingContext.ClosureParameters:
      case ParsingContext.CallArguments:
        return SyntaxKind.CommaToken;
      case ParsingContext.MatchCases:
      case ParsingContext.GroupedExpression:
      case ParsingContext.ComputedDictionaryKey:
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
      case ParsingContext.ProgramStatements:
      case ParsingContext.BlockStatements:
        return isStatementStart(kind);
      case ParsingContext.ArrayElements:
      case ParsingContext.CallArguments:
        return isExpressionStart(kind);
      case ParsingContext.DictionaryEntries:
        return isDictionaryEntryStart(kind);
      case ParsingContext.ClosureParameters:
      case ParsingContext.MatchCases:
      case ParsingContext.GroupedExpression:
      case ParsingContext.ComputedDictionaryKey:
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
    let cursor = this.#position;
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
          cursor += 1;
          return this.#tokens[cursor]?.kind === SyntaxKind.ArrowToken;
        }
      } else if (kind === SyntaxKind.EndOfFileToken) {
        return false;
      }
      cursor += 1;
    }
    return false;
  }

  #looksLikeBareClosure(): boolean {
    return isPatternStart(this.#peekKind())
      && this.#peekKindAfterCurrent() === SyntaxKind.ArrowToken;
  }

  #looksLikeDictionaryExpression(): boolean {
    let cursor = this.#position;
    if (this.#tokens[cursor]?.kind !== SyntaxKind.OpenBraceToken) {
      return false;
    }
    cursor += 1;
    const first = this.#tokens[cursor]?.kind;
    if (first === SyntaxKind.CloseBraceToken) {
      return true;
    }
    if (
      first === SyntaxKind.IdentifierToken
      || first === SyntaxKind.StringLiteralToken
      || first === SyntaxKind.NumberLiteralToken
    ) {
      cursor += 1;
      const next = this.#tokens[cursor]?.kind;
      return next === SyntaxKind.ColonToken
        || (first === SyntaxKind.IdentifierToken && next === SyntaxKind.CommaToken);
    }
    if (first !== SyntaxKind.OpenBracketToken) {
      return false;
    }

    const expectedClosers: SyntaxKind[] = [];
    while (cursor < this.#tokens.length) {
      const kind = this.#tokens[cursor]?.kind;
      const closer = closingDelimiterFor(kind);
      if (closer !== undefined) {
        expectedClosers.push(closer);
      } else if (expectedClosers.at(-1) === kind) {
        expectedClosers.pop();
        if (expectedClosers.length === 0) {
          cursor += 1;
          return this.#tokens[cursor]?.kind === SyntaxKind.ColonToken;
        }
      } else if (kind === SyntaxKind.EndOfFileToken) {
        return false;
      }
      cursor += 1;
    }
    return false;
  }

  #peekKindAfterCurrent(): SyntaxKind {
    return this.#tokens[this.#position + 1]?.kind ?? SyntaxKind.EndOfFileToken;
  }

  #looksLikeMatchSelection(): boolean {
    let cursor = this.#position;
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
      cursor += 1;
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
    const token = this.#tokens[this.#position];
    if (token === undefined) {
      throw new Error("Parser token stream is missing its EOF token.");
    }
    this.#position += 1;
    return token;
  }

  #peekToken(): SyntaxToken {
    const token = this.#tokens[this.#position];
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
    const offset = this.#tokens[this.#position]?.range.start ?? this.#source.length;
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
    const firstToken = this.#tokens[start];
    const startOffset = firstToken === undefined
      ? this.#source.length
      : tokenFullRange(firstToken).start;
    const endOffset = end > start
      ? (this.#tokens[end - 1] === undefined
          ? startOffset
          : tokenFullRange(this.#tokens[end - 1]!).end)
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
      const offset = this.#tokens[start]?.range.start ?? this.#source.length;
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
    || kind === SyntaxKind.IfKeyword
    || kind === SyntaxKind.MinusToken
    || kind === SyntaxKind.NotKeyword;
}

function isStatementStart(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.LetKeyword
    || kind === SyntaxKind.FnKeyword
    || isExpressionStart(kind);
}

function isDictionaryEntryStart(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.IdentifierToken
    || kind === SyntaxKind.NumberLiteralToken
    || kind === SyntaxKind.StringLiteralToken
    || kind === SyntaxKind.OpenBracketToken;
}

function isClosingDelimiter(kind: SyntaxKind | undefined): boolean {
  return kind === SyntaxKind.CloseParenToken
    || kind === SyntaxKind.CloseBracketToken
    || kind === SyntaxKind.CloseBraceToken;
}

function isKeywordRecoveryBoundary(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.ElseKeyword
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
  return token === undefined || token.kind === SyntaxKind.EndOfFileToken;
}

function diagnosticKey(value: Diagnostic): string {
  return `${value.code}:${value.range.start}:${value.range.end}:${value.message}`;
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
  [SyntaxKind.ElseKeyword, "'else'"],
  [SyntaxKind.IdentifierToken, "an identifier"],
]);
