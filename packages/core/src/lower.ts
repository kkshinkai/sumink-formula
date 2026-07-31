import type {
  BlockExpression,
  CallExpression,
  ClosureExpression,
  DictionaryEntry,
  Expression,
  ExportDeclaration,
  FileModule,
  FnStatement,
  IdentifierExpression,
  ImportClause,
  ImportDeclaration,
  ImportSelector,
  InfixOperator,
  InfixOperatorExpression,
  LetStatement,
  LiteralExpression,
  LiteralValue,
  MatchArm,
  MatchSelectionExpression,
  ModuleDeclaration,
  ModuleItem,
  ModulePath,
  NodeId,
  Pattern,
  Program,
  ProgramItem,
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

export interface LowerExpressionResult {
  readonly expression: Expression;
  readonly diagnostics: readonly Diagnostic[];
}

export interface LowerFileModuleResult {
  readonly fileModule: FileModule;
  readonly diagnostics: readonly Diagnostic[];
}

export function lower(parseResult: ParseResult): LowerResult {
  const lowerer = new Lowerer(parseResult);
  return {
    program: lowerer.lowerProgram(),
    diagnostics: parseResult.diagnostics,
  };
}

export function lowerExpression(parseResult: ParseResult): LowerExpressionResult {
  const lowerer = new Lowerer(parseResult);
  return {
    expression: lowerer.lowerExpressionRoot(),
    diagnostics: parseResult.diagnostics,
  };
}

export function lowerFileModule(parseResult: ParseResult): LowerFileModuleResult {
  const lowerer = new Lowerer(parseResult);
  return {
    fileModule: lowerer.lowerFileModule(),
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
      items: directNodes(node).flatMap((child) => {
        const item = this.#programItem(child);
        return item === undefined ? [] : [item];
      }),
    };
  }

  public lowerFileModule(): FileModule {
    const node = this.#parseResult.cst;
    if (node.kind !== CstKind.FileModule) {
      throw new TypeError("Expected a file-module CST.");
    }
    return {
      kind: "FileModule",
      id: this.#id(),
      range: node.range,
      items: this.#moduleItems(node),
    };
  }

  public lowerExpressionRoot(): Expression {
    const node = this.#parseResult.cst;
    if (node.kind !== CstKind.ExpressionRoot) {
      throw new TypeError("Expected an expression-root CST.");
    }
    const expression = directNodes(node).find(isExpressionCst);
    return this.#expressionOrError(expression, node.range);
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

  #programItem(node: CstNode): ProgramItem | undefined {
    const statement = this.#statement(node);
    if (statement !== undefined) {
      return statement;
    }
    if (node.kind === CstKind.ImportDeclaration) {
      return this.#importDeclaration(node);
    }
    if (node.kind === CstKind.ModuleDeclaration) {
      return this.#moduleDeclaration(node);
    }
    return undefined;
  }

  #moduleItems(node: CstNode): ModuleItem[] {
    const items: ModuleItem[] = [];
    for (const child of directNodes(node)) {
      const statement = this.#statement(child);
      if (statement?.kind === "LetStatement" || statement?.kind === "FnStatement") {
        items.push(statement);
        continue;
      }
      switch (child.kind) {
        case CstKind.ImportDeclaration:
          items.push(this.#importDeclaration(child));
          break;
        case CstKind.ExportDeclaration:
          items.push(this.#exportDeclaration(child));
          break;
        case CstKind.ModuleDeclaration:
          items.push(this.#moduleDeclaration(child));
          break;
      }
    }
    return items;
  }

  #moduleDeclaration(node: CstNode): ModuleDeclaration {
    const name = requiredDirectToken(node, SyntaxKind.IdentifierToken);
    return {
      kind: "ModuleDeclaration",
      id: this.#id(),
      range: node.range,
      name: name.value ?? "",
      nameRange: name.range,
      items: this.#moduleItems(node),
    };
  }

  #importDeclaration(node: CstNode): ImportDeclaration {
    const modulePathNode = directNodes(node).find((child) => child.kind === CstKind.ModulePath);
    const selectorList = directNodes(node).find((child) => child.kind === CstKind.ImportSelectorList);
    const sourceToken = directTokens(node).find((token) => token.kind === SyntaxKind.StringLiteralToken);
    const path = modulePathNode === undefined ? undefined : this.#modulePath(modulePathNode);
    const clause: ImportClause = selectorList === undefined
      ? {
          kind: "ModuleAliasImportClause",
          localName: sourceToken === undefined
            ? requiredDirectToken(node, SyntaxKind.IdentifierToken).value ?? ""
            : path?.segments[0]?.name ?? "",
          localNameRange: sourceToken === undefined
            ? requiredDirectToken(node, SyntaxKind.IdentifierToken).range
            : path?.segments[0]?.range ?? node.range,
        }
      : { kind: "MemberImportClause", selectors: this.#importSelectors(selectorList) };
    return {
      kind: "ImportDeclaration",
      id: this.#id(),
      range: node.range,
      ...(path === undefined ? {} : { modulePath: path }),
      ...(sourceToken === undefined
        ? {}
        : { source: sourceToken.value ?? "", sourceRange: sourceToken.range }),
      clause,
    };
  }

  #exportDeclaration(node: CstNode): ExportDeclaration {
    const declaration = directNodes(node).find((child) =>
      child.kind === CstKind.LetStatement
      || child.kind === CstKind.FnStatement
      || child.kind === CstKind.ModuleDeclaration
    );
    if (declaration !== undefined) {
      const lowered = declaration.kind === CstKind.ModuleDeclaration
        ? this.#moduleDeclaration(declaration)
        : declaration.kind === CstKind.FnStatement
          ? this.#fnStatement(declaration)
          : this.#statement(declaration);
      return {
        kind: "ExportDeclaration",
        id: this.#id(),
        range: node.range,
        ...(lowered === undefined || lowered.kind === "ExpressionStatement"
          ? {}
          : { declaration: lowered }),
      };
    }
    const pathNode = directNodes(node).find((child) => child.kind === CstKind.ModulePath);
    const selectorList = directNodes(node).find((child) => child.kind === CstKind.ImportSelectorList);
    return {
      kind: "ExportDeclaration",
      id: this.#id(),
      range: node.range,
      ...(pathNode === undefined ? {} : { modulePath: this.#modulePath(pathNode) }),
      ...(selectorList === undefined ? {} : { selectors: this.#importSelectors(selectorList) }),
    };
  }

  #modulePath(node: CstNode): ModulePath {
    return {
      kind: "ModulePath",
      id: this.#id(),
      range: node.range,
      segments: directTokens(node)
        .filter((token) => token.kind === SyntaxKind.IdentifierToken)
        .map((token) => ({ name: token.value ?? "", range: token.range })),
    };
  }

  #importSelectors(node: CstNode): ImportSelector[] {
    return directNodes(node).flatMap((selector): ImportSelector[] => {
      if (selector.kind === CstKind.WildcardImportSelector) {
        return [{ kind: "WildcardImportSelector", id: this.#id(), range: selector.range }];
      }
      if (selector.kind !== CstKind.ImportSelector) {
        return [];
      }
      const names = directTokens(selector)
        .filter((token) => token.kind === SyntaxKind.IdentifierToken);
      const imported = names[0] ?? requiredDirectToken(selector, SyntaxKind.IdentifierToken);
      const local = names[1];
      const excluded = local?.value === "_";
      return [{
        kind: "NamedImportSelector",
        id: this.#id(),
        range: selector.range,
        importedName: imported.value ?? "",
        importedNameRange: imported.range,
        ...(local === undefined || excluded
          ? {}
          : { localName: local.value ?? "", localNameRange: local.range }),
        excluded,
      }];
    });
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
      case CstKind.FieldSelectorExpression: {
        const field = requiredDirectToken(node, SyntaxKind.IdentifierToken);
        return {
          kind: "FieldSelectorExpression",
          id: this.#id(),
          range: node.range,
          receiver: this.#requiredExpression(node, 0),
          field: field.value ?? "",
          fieldRange: field.range,
        };
      }
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
    const blockBody = directNodes(node).find((child) => child.kind === CstKind.ClosureBlockBody);
    const body = blockBody === undefined
      ? this.#expressionOrError(directNodes(node).findLast(isExpressionCst), node.range)
      : this.#block(blockBody);
    return {
      kind: "ClosureExpression",
      id: this.#id(),
      range: node.range,
      parameters: directNodes(node)
        .filter((child) => child.kind === CstKind.ClosureParameter)
        .map((parameter) => this.#requiredPattern(parameter, 0)),
      body,
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
    const arms = directNodes(node)
      .filter((child) => child.kind === CstKind.MatchArm)
      .map((matchArm): MatchArm => ({
        kind: "MatchArm",
        id: this.#id(),
        range: matchArm.range,
        pattern: this.#requiredPattern(matchArm, 0),
        result: this.#requiredExpression(matchArm, 0),
      }));
    return { kind: "MatchSelectionExpression", id: this.#id(), range: node.range, subject, arms };
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
