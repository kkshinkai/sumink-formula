import type {
  ArrayExpression,
  BlockExpression,
  CallExpression,
  ClosureExpression,
  ConditionalBranch,
  Expression,
  IdentifierExpression,
  IfExpression,
  InfixOperator,
  InfixOperatorExpression,
  LetBinding,
  LetExpression,
  LiteralValue,
  MatchCase,
  MatchSelectionExpression,
  NodeId,
  ObjectKey,
  ObjectMember,
  Pattern,
  Program,
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
      expressions: directNodes(node).filter(isExpressionCst).map((child) => this.#expression(child)),
    };
  }

  #expression(node: CstNode): Expression {
    switch (node.kind) {
      case CstKind.ErrorExpression:
        return { kind: "ErrorExpression", id: this.#id(), range: node.range };
      case CstKind.LiteralExpression:
        return { kind: "LiteralExpression", id: this.#id(), range: node.range, value: literalValue(node) };
      case CstKind.IdentifierExpression:
        return this.#identifier(node);
      case CstKind.ArrayExpression:
        return {
          kind: "ArrayExpression",
          id: this.#id(),
          range: node.range,
          elements: directNodes(node).filter(isExpressionCst).map((child) => this.#expression(child)),
        } satisfies ArrayExpression;
      case CstKind.ObjectExpression:
        return {
          kind: "ObjectExpression",
          id: this.#id(),
          range: node.range,
          members: directNodes(node)
            .filter((child) => child.kind === CstKind.ObjectMember)
            .map((child) => this.#objectMember(child)),
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
        return {
          kind: "BlockExpression",
          id: this.#id(),
          range: node.range,
          expressions: directNodes(node).filter(isExpressionCst).map((child) => this.#expression(child)),
        } satisfies BlockExpression;
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
      case CstKind.LetExpression:
        return this.#letExpression(node);
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

  #identifier(node: CstNode): IdentifierExpression {
    return {
      kind: "IdentifierExpression",
      id: this.#id(),
      range: node.range,
      name: requiredDirectToken(node, SyntaxKind.IdentifierToken).value ?? "",
    };
  }

  #objectMember(node: CstNode): ObjectMember {
    const computed = directNodes(node).find((child) => child.kind === CstKind.ComputedObjectKey);
    const key: ObjectKey = computed === undefined
      ? this.#staticObjectKey(node)
      : {
          kind: "ComputedObjectKey",
          expression: this.#requiredExpression(computed, 0),
          range: computed.range,
        };

    return {
      kind: "ObjectMember",
      id: this.#id(),
      range: node.range,
      key,
      value: this.#requiredExpression(node, 0),
    };
  }

  #staticObjectKey(node: CstNode): ObjectKey {
    const token = directTokens(node).find((candidate) =>
      candidate.kind === SyntaxKind.IdentifierToken || candidate.kind === SyntaxKind.StringLiteralToken
    );
    return {
      kind: "StaticObjectKey",
      value: token?.value ?? "",
      range: token?.range ?? node.range,
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
    const callee: IdentifierExpression = {
      kind: "IdentifierExpression",
      id: this.#id(),
      range: operator.range,
      name: operator.value ?? "",
    };
    return {
      kind: "CallExpression",
      id: this.#id(),
      range: node.range,
      callee,
      arguments: [
        this.#expressionOrError(expressions[0], node.range),
        this.#expressionOrError(expressions[1], node.range),
      ],
    };
  }

  #closure(node: CstNode): ClosureExpression {
    const parameters = directNodes(node)
      .filter((child) => child.kind === CstKind.ClosureParameter)
      .map((parameter) => this.#requiredPattern(parameter, 0));
    const body = directNodes(node).findLast(isExpressionCst);
    return {
      kind: "ClosureExpression",
      id: this.#id(),
      range: node.range,
      parameters,
      body: this.#expressionOrError(body, node.range),
    };
  }

  #ifExpression(node: CstNode): IfExpression {
    const expressions = directNodes(node).filter(isExpressionCst);
    const branches: ConditionalBranch[] = [];
    branches.push({
      condition: this.#expressionOrError(expressions[0], node.range),
      result: this.#expressionOrError(expressions[1], node.range),
      range: spanNodes(expressions[0], expressions[1], node.range),
    });

    for (const clause of directNodes(node).filter((child) => child.kind === CstKind.ElifClause)) {
      const clauseExpressions = directNodes(clause).filter(isExpressionCst);
      branches.push({
        condition: this.#expressionOrError(clauseExpressions[0], clause.range),
        result: this.#expressionOrError(clauseExpressions[1], clause.range),
        range: clause.range,
      });
    }

    return {
      kind: "IfExpression",
      id: this.#id(),
      range: node.range,
      branches,
      elseBranch: this.#expressionOrError(expressions[2], node.range),
    };
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

  #letExpression(node: CstNode): LetExpression {
    const bindings = directNodes(node)
      .filter((child) => child.kind === CstKind.LetBinding)
      .map((binding): LetBinding => ({
        kind: "LetBinding",
        id: this.#id(),
        range: binding.range,
        pattern: this.#requiredPattern(binding, 0),
        value: this.#requiredExpression(binding, 0),
      }));
    const body = directNodes(node).findLast(isExpressionCst);
    return {
      kind: "LetExpression",
      id: this.#id(),
      range: node.range,
      bindings,
      body: this.#expressionOrError(body, node.range),
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
  if (token === undefined) {
    return { type: "token", kind, range: node.range, flags: 0 };
  }
  return token;
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

function spanNodes(first: CstNode | undefined, second: CstNode | undefined, fallback: TextRange): TextRange {
  return first === undefined || second === undefined
    ? fallback
    : { start: first.range.start, end: second.range.end };
}
