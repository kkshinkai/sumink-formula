import type { TextRange } from "./text.js";
import type { SyntaxKind } from "./syntax-kind.js";

export const enum TokenFlags {
  None = 0,
  Unterminated = 1 << 0,
  ContainsInvalidEscape = 1 << 1,
  ContainsInvalidUnicodeScalar = 1 << 2,
  ContainsInvalidCharacter = 1 << 3,
}

export interface SyntaxToken {
  readonly type: "token";
  readonly kind: SyntaxKind;
  readonly range: TextRange;
  /** Identifier/keyword spelling, raw number spelling, or decoded string value. */
  readonly value?: string;
  readonly flags: TokenFlags;
}
