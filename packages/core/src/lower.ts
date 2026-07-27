import type {
  BlockExpression,
  CallExpression,
  ClosureExpression,
  DictionaryEntry,
  Expression,
  FnStatement,
  IdentifierExpression,
  InfixOperator,
  InfixOperatorExpression,
  LetStatement,
  LiteralExpression,
  LiteralValue,
  MatchCase,
  MatchSelectionExpression,
  NodeId,
  Pattern,
  Program,
  Statement,
} from "./ast.js";
import { CstKind, type CstNode } from "./cst.js";
import type { Diagnostic } from "./diagnostic.js";
import type { ParseResult } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import type { TextRange } from "./text.js";
import type { SyntaxToken } from "./token.js";

export interface LowerResult {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
}

export function lower(parseResult: ParseResult): LowerResult {
  const lowerer = new Lowerer(parseResult);
  return {
    program: lowerer.lowerProgram(),
    diagnostics: parseResult.diagnostics,
  };
}

class Lowerer {
  readonly #parseResult: ParseResult;
  #nextNodeId = 0;

  public constructor(parseResult: ParseResult) {
    this.#parseResult = parseResult;
  }

  public lowerProgram(): Program {
    const node = this.#parseResult.cst;
    return {
      kind: "Program",
      id: this.#id(),
      range: node.range,
      statements: directNodes(node).flatMap((child) => {
        const statement = this.#statement(child);
        return statement === undefined ? [] : [statement];
      }),
    };
  }

  #statement(node: CstNode): Statement | undefined {
    switch (node.kind) {
      case CstKind.EmptyStatement:
        return undefined;
      case CstKind.LetStatement:
        return {
          kind: "LetStatement",
          id: this.#id(),
          range: node.range,
          pattern: this.#requiredPattern(node, 0),
          value: this.#requiredExpression(node, 0),
        } satisfies LetStatement;
      case CstKind.FnStatement:
        return this.#fnStatement(node);
      case CstKind.ExpressionStatement:
        return {
          kind: "ExpressionStatement",
          id: this.#id(),
          range: node.range,
          expression: this.#requiredExpression(node, 0),
        };
      default:
        return undefined;
    }
  }

  #fnStatement(node: CstNode): FnStatement {
    const name = requiredDirectToken(node, SyntaxKind.IdentifierToken);
    return {
      kind: "FnStatement",
      id: this.#id(),
      range: node.range,
      name: name.value ?? "",
      nameRange: name.range,
      parameters: directNodes(node)
        .filter((child) => child.kind === CstKind.ClosureParameter)
        .map((parameter) => this.#requiredPattern(parameter, 0)),
      body: this.#requiredExpression(node, 0),
    };
  }

  #expression(node: CstNode): Expression {
    switch (node.kind) {
      case CstKind.ErrorExpression:
        return { kind: "ErrorExpression", id: this.#id(), range: node.range };
      case CstKind.LiteralExpression:
        return this.#literal(node);
      case CstKind.IdentifierExpression:
        return this.#identifier(node);
      case CstKind.ArrayExpression:
        return {
          kind: "ArrayExpression",
          id: this.#id(),
          range: node.range,
          elements: directNodes(node).filter(isExpressionCst).map((child) => this.#expression(child)),
        };
      case CstKind.DictionaryExpression:
        return {
          kind: "DictionaryExpression",
          id: this.#id(),
          range: node.range,
          entries: directNodes(node)
            .filter((child) =>
              child.kind === CstKind.DictionaryEntry
              || child.kind === CstKind.ShorthandDictionaryEntry
            )
            .map((child) => this.#dictionaryEntry(child)),
        };
      case CstKind.CallExpression:
        return this.#call(node);
      case CstKind.InfixCallExpression:
        return this.#infixCall(node);
      case CstKind.GroupedExpression:
        return {
          kind: "GroupedExpression",
          id: this.#id(),
          range: node.range,
          expression: this.#requiredExpression(node, 0),
        };
      case CstKind.ClosureExpression:
        return this.#closure(node);
      case CstKind.BlockExpression:
        return this.#block(node);
      case CstKind.IfExpression:
        return this.#ifExpression(node);
      case CstKind.PrefixOperatorExpression:
        return {
          kind: "PrefixOperatorExpression",
          id: this.#id(),
          range: node.range,
          operator: requiredPrefixOperator(node),
          operand: this.#requiredExpression(node, 0),
        };
      case CstKind.InfixOperatorExpression:
        return this.#infixOperator(node);
      case CstKind.FieldSelectorExpression:
        return {
          kind: "FieldSelectorExpression",
          id: this.#id(),
          range: node.range,
          receiver: this.#requiredExpression(node, 0),
          field: requiredDirectToken(node, SyntaxKind.IdentifierToken).value ?? "",
        };
      case CstKind.ComputedSelectorExpression:
        return {
          kind: "ComputedSelectorExpression",
          id: this.#id(),
          range: node.range,
          receiver: this.#requiredExpression(node, 0),
          selector: this.#requiredExpression(node, 1),
        };
      case CstKind.MatchTestExpression:
        return {
          kind: "MatchTestExpression",
          id: this.#id(),
          range: node.range,
          subject: this.#requiredExpression(node, 0),
          pattern: this.#requiredPattern(node, 0),
        };
      case CstKind.MatchSelectionExpression:
        return this.#matchSelection(node);
      default:
        return { kind: "ErrorExpression", id: this.#id(), range: node.range };
    }
  }

  #literal(node: CstNode): LiteralExpression {
    return { kind: "LiteralExpression", id: this.#id(), range: node.range, value: literalValue(node) };
  }

  #identifier(node: CstNode): IdentifierExpression {
    return {
      kind: "IdentifierExpression",
      id: this.#id(),
      range: node.range,
      name: requiredDirectToken(node, SyntaxKind.IdentifierToken).value ?? "",
    };
  }

  #dictionaryEntry(node: CstNode): DictionaryEntry {
    if (node.kind === CstKind.ShorthandDictionaryEntry) {
      const token = requiredDirectToken(node, SyntaxKind.IdentifierToken);
      return {
        kind: "DictionaryEntry",
        id: this.#id(),
        range: node.range,
        key: {
          kind: "LiteralExpression",
          id: this.#id(),
          range: token.range,
          value: token.value ?? "",
        },
        value: {
          kind: "IdentifierExpression",
          id: this.#id(),
          range: token.range,
          name: token.value ?? "",
        },
      };
    }

    const computed = directNodes(node).find((child) => child.kind === CstKind.ComputedDictionaryKey);
    return {
      kind: "DictionaryEntry",
      id: this.#id(),
      range: node.range,
      key: computed === undefined
        ? this.#staticDictionaryKey(node)
        : this.#requiredExpression(computed, 0),
      value: this.#requiredExpression(node, 0),
    };
  }

  #staticDictionaryKey(node: CstNode): Expression {
    const token = directTokens(node).find((candidate) =>
      candidate.kind === SyntaxKind.IdentifierToken
      || candidate.kind === SyntaxKind.StringLiteralToken
      || candidate.kind === SyntaxKind.NumberLiteralToken
    );
    if (token === undefined) {
      return { kind: "ErrorExpression", id: this.#id(), range: node.range };
    }
    return {
      kind: "LiteralExpression",
      id: this.#id(),
      range: token.range,
      value: token.kind === SyntaxKind.NumberLiteralToken
        ? Number(token.value)
        : token.value ?? "",
    };
  }

  #call(node: CstNode): CallExpression {
    const expressions = directNodes(node).filter(isExpressionCst);
    return {
      kind: "CallExpression",
      id: this.#id(),
      range: node.range,
      callee: this.#expressionOrError(expressions[0], node.range),
      arguments: expressions.slice(1).map((child) => this.#expression(child)),
    };
  }

  #infixCall(node: CstNode): CallExpression {
    const expressions = directNodes(node).filter(isExpressionCst);
    const operator = requiredDirectToken(node, SyntaxKind.IdentifierToken);
    return {
      kind: "CallExpression",
      id: this.#id(),
      range: node.range,
      callee: {
        kind: "IdentifierExpression",
        id: this.#id(),
        range: operator.range,
        name: operator.value ?? "",
      },
      arguments: [
        this.#expressionOrError(expressions[0], node.range),
        this.#expressionOrError(expressions[1], node.range),
      ],
    };
  }

  #closure(node: CstNode): ClosureExpression {
    const body = directNodes(node).findLast(isExpressionCst);
    return {
      kind: "ClosureExpression",
      id: this.#id(),
      range: node.range,
      parameters: directNodes(node)
        .filter((child) => child.kind === CstKind.ClosureParameter)
        .map((parameter) => this.#requiredPattern(parameter, 0)),
      body: this.#expressionOrError(body, node.range),
    };
  }

  #block(node: CstNode): BlockExpression {
    const statements = directNodes(node).flatMap((child) => {
      const statement = this.#statement(child);
      return statement === undefined ? [] : [statement];
    });
    const resultNode = directNodes(node).findLast(isExpressionCst);
    const base = { kind: "BlockExpression" as const, id: this.#id(), range: node.range, statements };
    return resultNode === undefined ? base : { ...base, result: this.#expression(resultNode) };
  }

  #ifExpression(node: CstNode): Expression {
    const expressions = directNodes(node).filter(isExpressionCst);
    const base = {
      kind: "IfExpression" as const,
      id: this.#id(),
      range: node.range,
      condition: this.#expressionOrError(expressions[0], node.range),
      consequent: this.#expressionOrError(expressions[1], node.range),
    };
    return expressions[2] === undefined
      ? base
      : { ...base, alternative: this.#expression(expressions[2]) };
  }

  #infixOperator(node: CstNode): InfixOperatorExpression {
    return {
      kind: "InfixOperatorExpression",
      id: this.#id(),
      range: node.range,
      operator: requiredInfixOperator(node),
      left: this.#requiredExpression(node, 0),
      right: this.#requiredExpression(node, 1),
    };
  }

  #matchSelection(node: CstNode): MatchSelectionExpression {
    const subject = this.#requiredExpression(node, 0);
    const cases = directNodes(node)
      .filter((child) => child.kind === CstKind.MatchCase)
      .map((matchCase): MatchCase => ({
        kind: "MatchCase",
        id: this.#id(),
        range: matchCase.range,
        pattern: this.#requiredPattern(matchCase, 0),
        result: this.#requiredExpression(matchCase, 0),
      }));
    const elseNode = directNodes(node).find((child) => child.kind === CstKind.MatchElse);
    const elseBranch = elseNode === undefined ? undefined : this.#requiredExpression(elseNode, 0);
    return elseBranch === undefined
      ? { kind: "MatchSelectionExpression", id: this.#id(), range: node.range, subject, cases }
      : { kind: "MatchSelectionExpression", id: this.#id(), range: node.range, subject, cases, elseBranch };
  }

  #pattern(node: CstNode): Pattern {
    switch (node.kind) {
      case CstKind.LiteralPattern:
        return { kind: "LiteralPattern", id: this.#id(), range: node.range, value: literalValue(node) };
      case CstKind.IdentifierPattern:
        return {
          kind: "IdentifierPattern",
          id: this.#id(),
          range: node.range,
          name: requiredDirectToken(node, SyntaxKind.IdentifierToken).value ?? "",
        };
      case CstKind.WildcardPattern:
        return { kind: "WildcardPattern", id: this.#id(), range: node.range };
      default:
        return { kind: "ErrorPattern", id: this.#id(), range: node.range };
    }
  }

  #requiredExpression(node: CstNode, index: number): Expression {
    return this.#expressionOrError(directNodes(node).filter(isExpressionCst)[index], node.range);
  }

  #expressionOrError(node: CstNode | undefined, range: TextRange): Expression {
    return node === undefined
      ? { kind: "ErrorExpression", id: this.#id(), range }
      : this.#expression(node);
  }

  #requiredPattern(node: CstNode, index: number): Pattern {
    const pattern = directNodes(node).filter(isPatternCst)[index];
    return pattern === undefined
      ? { kind: "ErrorPattern", id: this.#id(), range: node.range }
      : this.#pattern(pattern);
  }

  #id(): NodeId {
    const id = this.#nextNodeId;
    this.#nextNodeId += 1;
    return id as NodeId;
  }
}

function directNodes(node: CstNode): CstNode[] {
  return node.children.filter((child): child is CstNode => child.type === "node");
}

function directTokens(node: CstNode): SyntaxToken[] {
  return node.children.filter((child): child is SyntaxToken => child.type === "token");
}

function requiredDirectToken(node: CstNode, kind: SyntaxToken["kind"]): SyntaxToken {
  const token = directTokens(node).find((candidate) => candidate.kind === kind);
  return token ?? {
    type: "token",
    kind,
    range: node.range,
    leadingTrivia: [],
    trailingTrivia: [],
    flags: 0,
  };
}

function literalValue(node: CstNode): LiteralValue {
  const token = directTokens(node).find((candidate) =>
    candidate.kind === SyntaxKind.NumberLiteralToken
    || candidate.kind === SyntaxKind.StringLiteralToken
    || candidate.kind === SyntaxKind.NilKeyword
    || candidate.kind === SyntaxKind.TrueKeyword
    || candidate.kind === SyntaxKind.FalseKeyword
  );
  switch (token?.kind) {
    case SyntaxKind.NumberLiteralToken:
      return Number(token.value);
    case SyntaxKind.StringLiteralToken:
      return token.value ?? "";
    case SyntaxKind.TrueKeyword:
      return true;
    case SyntaxKind.FalseKeyword:
      return false;
    default:
      return null;
  }
}

function requiredOperator(node: CstNode): string {
  const token = directTokens(node).find((candidate) => operatorSpellings.has(candidate.kind));
  return token === undefined ? "" : operatorSpellings.get(token.kind) ?? token.value ?? "";
}

function requiredPrefixOperator(node: CstNode): "-" | "not" {
  return requiredOperator(node) === "-" ? "-" : "not";
}

function requiredInfixOperator(node: CstNode): InfixOperator {
  const operator = requiredOperator(node);
  return isInfixOperator(operator) ? operator : "==";
}

function isInfixOperator(value: string): value is InfixOperator {
  return value === "+" || value === "-" || value === "*" || value === "/" || value === "%"
    || value === "<" || value === "<=" || value === ">" || value === ">="
    || value === "==" || value === "!=" || value === "and" || value === "or";
}

const operatorSpellings = new Map<SyntaxToken["kind"], string>([
  [SyntaxKind.MinusToken, "-"],
  [SyntaxKind.NotKeyword, "not"],
  [SyntaxKind.PlusToken, "+"],
  [SyntaxKind.AsteriskToken, "*"],
  [SyntaxKind.SlashToken, "/"],
  [SyntaxKind.PercentToken, "%"],
  [SyntaxKind.LessThanToken, "<"],
  [SyntaxKind.LessThanEqualsToken, "<="],
  [SyntaxKind.GreaterThanToken, ">"],
  [SyntaxKind.GreaterThanEqualsToken, ">="],
  [SyntaxKind.EqualsEqualsToken, "=="],
  [SyntaxKind.BangEqualsToken, "!="],
  [SyntaxKind.AndKeyword, "and"],
  [SyntaxKind.OrKeyword, "or"],
  [SyntaxKind.AmpersandAmpersandToken, "and"],
  [SyntaxKind.BarBarToken, "or"],
]);

function isExpressionCst(node: CstNode): boolean {
  return node.kind >= CstKind.FirstExpression && node.kind <= CstKind.LastExpression;
}

function isPatternCst(node: CstNode): boolean {
  return node.kind >= CstKind.FirstPattern && node.kind <= CstKind.LastPattern;
}
