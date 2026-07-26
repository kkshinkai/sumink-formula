import type { SyntaxKind } from "./syntax-kind.js";
import type { TextRange } from "./text.js";
import type { SyntaxToken } from "./token.js";

export const enum CstKind {
  Program,

  ErrorExpression,
  LiteralExpression,
  IdentifierExpression,
  ArrayExpression,
  ObjectExpression,
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
  LetExpression,
  MatchTestExpression,
  MatchSelectionExpression,

  ObjectMember,
  ComputedObjectKey,
  ClosureParameter,
  ElifClause,
  LetBinding,
  MatchCase,
  MatchElse,

  LiteralPattern,
  IdentifierPattern,
  WildcardPattern,
  ErrorPattern,

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
  /** Range including trivia owned by this node. */
  readonly fullRange: TextRange;
  /** Half-open indexes into ParseResult.tokens. */
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
