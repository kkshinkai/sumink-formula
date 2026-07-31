import type { SyntaxKind } from "./syntax-kind.js";
import type { TextRange } from "./text.js";
import type { SyntaxToken } from "./token.js";

export const enum CstKind {
  ExpressionRoot,
  Program,
  FileModule,

  EmptyStatement,
  LetStatement,
  FnStatement,
  ExpressionStatement,

  ImportDeclaration,
  ExportDeclaration,
  ModuleDeclaration,
  ModulePath,
  ImportSelectorList,
  ImportSelector,
  WildcardImportSelector,

  ErrorExpression,
  LiteralExpression,
  IdentifierExpression,
  ArrayExpression,
  DictionaryExpression,
  CallExpression,
  InfixCallExpression,
  GroupedExpression,
  ClosureExpression,
  BlockExpression,
  IfExpression,
  PrefixOperatorExpression,
  InfixOperatorExpression,
  FieldSelectorExpression,
  ComputedSelectorExpression,
  MatchTestExpression,
  MatchSelectionExpression,

  DictionaryEntry,
  ShorthandDictionaryEntry,
  ComputedDictionaryKey,
  ClosureParameter,
  ClosureBlockBody,
  MatchArm,

  LiteralPattern,
  IdentifierPattern,
  WildcardPattern,
  ErrorPattern,

  FirstStatement = EmptyStatement,
  LastStatement = ExpressionStatement,
  FirstExpression = ErrorExpression,
  LastExpression = MatchSelectionExpression,
  FirstPattern = LiteralPattern,
  LastPattern = ErrorPattern,
}

export interface CstNode {
  readonly type: "node";
  readonly kind: CstKind;
  /** Range from the first through last significant token. */
  readonly range: TextRange;
  /** Range including trivia owned by the boundary tokens of this node. */
  readonly fullRange: TextRange;
  /** Half-open indexes into ParseResult.tokens; trivia is stored on those tokens. */
  readonly tokenRange: TextRange;
  readonly children: readonly CstElement[];
}

export interface CstMissingToken {
  readonly type: "missing-token";
  readonly expectedKind: SyntaxKind;
  readonly range: TextRange;
  /** Insertion point in ParseResult.tokens. */
  readonly tokenIndex: number;
}

/** Source tokens consumed solely to recover from malformed syntax. */
export interface CstSkippedTokens {
  readonly type: "skipped-tokens";
  /** Range from the first through last significant skipped token. */
  readonly range: TextRange;
  /** Range including trivia captured with the skipped tokens. */
  readonly fullRange: TextRange;
  /** Half-open indexes into ParseResult.tokens. */
  readonly tokenRange: TextRange;
  readonly tokens: readonly SyntaxToken[];
}

export type CstElement = CstNode | CstMissingToken | CstSkippedTokens | SyntaxToken;

export function isCstNode(element: CstElement): element is CstNode {
  return element.type === "node";
}
