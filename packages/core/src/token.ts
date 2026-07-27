import type { TextRange } from "./text.js";
import type { SyntaxKind } from "./syntax-kind.js";

export const enum TriviaKind {
  Whitespace,
  LineComment,
  BlockComment,
}

export const enum TriviaFlags {
  None = 0,
  Unterminated = 1 << 0,
}

export const enum TokenFlags {
  None = 0,
  Unterminated = 1 << 0,
  ContainsInvalidEscape = 1 << 1,
  ContainsInvalidUnicodeScalar = 1 << 2,
  ContainsInvalidCharacter = 1 << 3,
}

export interface SyntaxTrivia {
  readonly type: "trivia";
  readonly kind: TriviaKind;
  readonly range: TextRange;
  readonly flags: TriviaFlags;
}

export interface SyntaxToken {
  readonly type: "token";
  readonly kind: SyntaxKind;
  /** Source occupied by the token spelling, excluding trivia. */
  readonly range: TextRange;
  /**
   * Trivia lexically owned by this token before its spelling. This includes
   * line breaks that separate it from the preceding token.
   */
  readonly leadingTrivia: readonly SyntaxTrivia[];
  /**
   * Trivia lexically owned by this token after its spelling, stopping before
   * the next line break. A block comment is one piece even when it spans lines.
   */
  readonly trailingTrivia: readonly SyntaxTrivia[];
  /** Identifier/keyword spelling, raw number spelling, or decoded string value. */
  readonly value?: string;
  readonly flags: TokenFlags;
}

export function tokenFullRange(token: SyntaxToken): TextRange {
  return {
    start: token.leadingTrivia[0]?.range.start ?? token.range.start,
    end: token.trailingTrivia.at(-1)?.range.end ?? token.range.end,
  };
}
