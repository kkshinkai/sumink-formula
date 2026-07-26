import { diagnostic, sortDiagnostics, type Diagnostic } from "./diagnostic.js";
import { keywordKind, SyntaxKind } from "./syntax-kind.js";
import { SourceText, textRange } from "./text.js";
import { TokenFlags, type SyntaxToken } from "./token.js";
import {
  unicodeIdentifierContinueRanges,
  unicodeIdentifierStartRanges,
} from "./unicode-identifier-ranges.generated.js";

export interface LexResult {
  readonly source: SourceText;
  readonly tokens: readonly SyntaxToken[];
  readonly diagnostics: readonly Diagnostic[];
}

export function lex(text: string | SourceText): LexResult {
  const source = typeof text === "string" ? new SourceText(text) : text;
  const lexer = new Lexer(source);
  return lexer.scanAll();
}

class Lexer {
  readonly #source: SourceText;
  readonly #text: string;
  readonly #tokens: SyntaxToken[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  #position = 0;

  public constructor(source: SourceText) {
    this.#source = source;
    this.#text = source.toString();
  }

  public scanAll(): LexResult {
    while (this.#position < this.#text.length) {
      const start = this.#position;
      const codePoint = this.#codePointAt(start);

      if (codePoint === undefined) {
        break;
      }

      if (isWhitespace(codePoint)) {
        this.#scanWhitespace(start);
      } else if (isDecimalDigit(codePoint)) {
        this.#scanNumber(start);
      } else if (codePoint === 0x22 || codePoint === 0x27) {
        this.#scanString(start, codePoint);
      } else {
        if (isIdentifierStart(codePoint)) {
          this.#scanIdentifier(start);
        } else {
          this.#scanPunctuationOrUnknown(start, codePoint);
        }
      }
    }

    this.#tokens.push({
      type: "token",
      kind: SyntaxKind.EndOfFileToken,
      range: textRange(this.#position, this.#position),
      flags: TokenFlags.None,
    });

    return {
      source: this.#source,
      tokens: this.#tokens,
      diagnostics: sortDiagnostics(this.#diagnostics),
    };
  }

  #scanWhitespace(start: number): void {
    while (this.#position < this.#text.length) {
      const codePoint = this.#codePointAt(this.#position);
      if (codePoint === undefined || !isWhitespace(codePoint)) {
        break;
      }
      this.#advanceCodePoint(codePoint);
    }

    this.#pushToken(SyntaxKind.WhitespaceTrivia, start);
  }

  #scanIdentifier(start: number): void {
    const first = this.#codePointAt(this.#position);
    if (first === undefined) {
      return;
    }
    this.#advanceCodePoint(first);

    while (this.#position < this.#text.length) {
      const codePoint = this.#codePointAt(this.#position);
      if (codePoint === undefined) {
        break;
      }
      if (!isIdentifierContinue(codePoint)) {
        break;
      }
      this.#advanceCodePoint(codePoint);
    }

    const value = this.#text.slice(start, this.#position);
    this.#pushToken(keywordKind(value) ?? SyntaxKind.IdentifierToken, start, value);
  }

  #scanNumber(start: number): void {
    if (this.#text.charCodeAt(this.#position) === 0x30) {
      this.#position += 1;
      if (isDecimalDigit(this.#text.charCodeAt(this.#position))) {
        while (isDecimalDigit(this.#text.charCodeAt(this.#position))) {
          this.#position += 1;
        }
        this.#diagnostics.push(
          diagnostic(
            "SF1001",
            "lex",
            "A decimal integer cannot have a leading zero.",
            textRange(start, this.#position),
          ),
        );
      }
    } else {
      while (isDecimalDigit(this.#text.charCodeAt(this.#position))) {
        this.#position += 1;
      }
    }

    if (this.#text.charCodeAt(this.#position) === 0x2e) {
      if (isDecimalDigit(this.#text.charCodeAt(this.#position + 1))) {
        this.#position += 2;
        while (isDecimalDigit(this.#text.charCodeAt(this.#position))) {
          this.#position += 1;
        }
      }
    }

    const exponent = this.#text.charCodeAt(this.#position);
    if (exponent === 0x45 || exponent === 0x65) {
      const exponentStart = this.#position;
      let cursor = exponentStart + 1;
      const sign = this.#text.charCodeAt(cursor);
      if (sign === 0x2b || sign === 0x2d) {
        cursor += 1;
      }

      if (isDecimalDigit(this.#text.charCodeAt(cursor))) {
        this.#position = cursor + 1;
        while (isDecimalDigit(this.#text.charCodeAt(this.#position))) {
          this.#position += 1;
        }
      } else {
        this.#position = cursor;
        this.#diagnostics.push(
          diagnostic(
            "SF1002",
            "lex",
            "A numeric exponent requires at least one digit.",
            textRange(exponentStart, this.#position),
          ),
        );
      }
    }

    this.#pushToken(SyntaxKind.NumberLiteralToken, start, this.#text.slice(start, this.#position));
  }

  #scanString(start: number, quote: number): void {
    this.#position += 1;
    let value = "";
    let flags: TokenFlags = TokenFlags.None;

    while (this.#position < this.#text.length) {
      const characterStart = this.#position;
      const codePoint = this.#codePointAt(characterStart);
      if (codePoint === undefined) {
        break;
      }

      if (codePoint === quote) {
        this.#position += 1;
        if (hasUnpairedSurrogate(value)) {
          flags |= TokenFlags.ContainsInvalidUnicodeScalar;
          this.#diagnostics.push(
            diagnostic(
              "SF1005",
              "lex",
              "A string literal evaluates to an unpaired UTF-16 surrogate.",
              textRange(start, this.#position),
            ),
          );
        }
        this.#pushToken(SyntaxKind.StringLiteralToken, start, value, flags);
        return;
      }

      if (codePoint === 0x0a || codePoint === 0x0d) {
        break;
      }

      if (codePoint < 0x20) {
        this.#advanceCodePoint(codePoint);
        flags |= TokenFlags.ContainsInvalidCharacter;
        this.#diagnostics.push(
          diagnostic(
            "SF1007",
            "lex",
            "A string literal contains an unescaped control character.",
            textRange(characterStart, this.#position),
          ),
        );
        value += "\ufffd";
        continue;
      }

      if (codePoint === 0x5c) {
        const escape = this.#scanEscape(characterStart);
        value += escape.value;
        flags |= escape.flags;
        continue;
      }

      if (isSurrogateCodeUnit(this.#text.charCodeAt(characterStart)) && codePoint <= 0xffff) {
        this.#position += 1;
        flags |= TokenFlags.ContainsInvalidUnicodeScalar;
        this.#diagnostics.push(
          diagnostic(
            "SF1005",
            "lex",
            "A string literal contains an unpaired UTF-16 surrogate.",
            textRange(characterStart, this.#position),
          ),
        );
        value += "\ufffd";
        continue;
      }

      this.#advanceCodePoint(codePoint);
      value += String.fromCodePoint(codePoint);
    }

    flags |= TokenFlags.Unterminated;
    this.#diagnostics.push(
      diagnostic("SF1003", "lex", "Unterminated string literal.", textRange(start, this.#position)),
    );
    this.#pushToken(SyntaxKind.StringLiteralToken, start, value, flags);
  }

  #scanEscape(start: number): { readonly value: string; readonly flags: TokenFlags } {
    this.#position += 1;
    const escaped = this.#text.charCodeAt(this.#position);
    const simpleEscape = simpleEscapes.get(escaped);
    if (simpleEscape !== undefined) {
      this.#position += 1;
      return { value: simpleEscape, flags: TokenFlags.None };
    }

    if (escaped === 0x75) {
      this.#position += 1;
      const digitsStart = this.#position;
      let digits = 0;
      while (digits < 4 && isHexDigit(this.#text.charCodeAt(this.#position))) {
        this.#position += 1;
        digits += 1;
      }

      if (digits === 4) {
        return {
          value: String.fromCharCode(Number.parseInt(this.#text.slice(digitsStart, this.#position), 16)),
          flags: TokenFlags.None,
        };
      }
    } else if (this.#position < this.#text.length) {
      this.#position += 1;
    }

    this.#diagnostics.push(
      diagnostic("SF1004", "lex", "Invalid escape sequence.", textRange(start, this.#position)),
    );
    return { value: "\ufffd", flags: TokenFlags.ContainsInvalidEscape };
  }

  #scanPunctuationOrUnknown(start: number, codePoint: number): void {
    if (isSurrogateCodeUnit(this.#text.charCodeAt(start)) && codePoint <= 0xffff) {
      this.#position += 1;
      this.#diagnostics.push(
        diagnostic("SF1006", "lex", "Unpaired UTF-16 surrogate.", textRange(start, this.#position)),
      );
      this.#pushToken(
        SyntaxKind.UnknownToken,
        start,
        undefined,
        TokenFlags.ContainsInvalidUnicodeScalar,
      );
      return;
    }

    const twoCharacters = this.#text.slice(start, start + 2);
    const doubleKind = doubleCharacterTokens.get(twoCharacters);
    if (doubleKind !== undefined) {
      this.#position += 2;
      this.#pushToken(doubleKind, start);
      return;
    }

    const singleKind = singleCharacterTokens.get(codePoint);
    if (singleKind !== undefined) {
      this.#advanceCodePoint(codePoint);
      this.#pushToken(singleKind, start);
      return;
    }

    this.#advanceCodePoint(codePoint);
    while (this.#position < this.#text.length) {
      const next = this.#codePointAt(this.#position);
      if (next === undefined || !isUnrecognizedPunctuation(this.#text, this.#position, next)) {
        break;
      }
      this.#advanceCodePoint(next);
    }
    const spelling = this.#text.slice(start, this.#position);
    this.#diagnostics.push(
      diagnostic(
        "SF1000",
        "lex",
        spelling.length === 1
          ? `Unexpected character ${JSON.stringify(spelling)}.`
          : `Unexpected token ${JSON.stringify(spelling)}.`,
        textRange(start, this.#position),
      ),
    );
    this.#pushToken(
      SyntaxKind.UnknownToken,
      start,
      undefined,
      TokenFlags.ContainsInvalidCharacter,
    );
  }

  #pushToken(
    kind: SyntaxToken["kind"],
    start: number,
    value?: string,
    flags: TokenFlags = TokenFlags.None,
  ): void {
    const token: SyntaxToken = value === undefined
      ? { type: "token", kind, range: textRange(start, this.#position), flags }
      : { type: "token", kind, range: textRange(start, this.#position), value, flags };
    this.#tokens.push(token);
  }

  #codePointAt(offset: number): number | undefined {
    return this.#text.codePointAt(offset);
  }

  #advanceCodePoint(codePoint: number): void {
    this.#position += codePoint > 0xffff ? 2 : 1;
  }
}

const simpleEscapes = new Map<number, string>([
  [0x22, "\""],
  [0x27, "'"],
  [0x5c, "\\"],
  [0x62, "\b"],
  [0x66, "\f"],
  [0x6e, "\n"],
  [0x72, "\r"],
  [0x74, "\t"],
]);

const doubleCharacterTokens = new Map<string, SyntaxToken["kind"]>([
  ["->", SyntaxKind.ArrowToken],
  ["==", SyntaxKind.EqualsEqualsToken],
  ["!=", SyntaxKind.BangEqualsToken],
  ["&&", SyntaxKind.AmpersandAmpersandToken],
  ["||", SyntaxKind.BarBarToken],
  ["<=", SyntaxKind.LessThanEqualsToken],
  [">=", SyntaxKind.GreaterThanEqualsToken],
]);

const singleCharacterTokens = new Map<number, SyntaxToken["kind"]>([
  [0x28, SyntaxKind.OpenParenToken],
  [0x29, SyntaxKind.CloseParenToken],
  [0x5b, SyntaxKind.OpenBracketToken],
  [0x5d, SyntaxKind.CloseBracketToken],
  [0x7b, SyntaxKind.OpenBraceToken],
  [0x7d, SyntaxKind.CloseBraceToken],
  [0x2c, SyntaxKind.CommaToken],
  [0x3b, SyntaxKind.SemicolonToken],
  [0x3a, SyntaxKind.ColonToken],
  [0x2e, SyntaxKind.DotToken],
  [0x3d, SyntaxKind.EqualsToken],
  [0x3c, SyntaxKind.LessThanToken],
  [0x3e, SyntaxKind.GreaterThanToken],
  [0x2b, SyntaxKind.PlusToken],
  [0x2d, SyntaxKind.MinusToken],
  [0x2a, SyntaxKind.AsteriskToken],
  [0x2f, SyntaxKind.SlashToken],
  [0x25, SyntaxKind.PercentToken],
]);

function isWhitespace(codePoint: number): boolean {
  return codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
}

function isUnrecognizedPunctuation(text: string, position: number, codePoint: number): boolean {
  if (isWhitespace(codePoint) || isDecimalDigit(codePoint) || codePoint === 0x22 || codePoint === 0x27) {
    return false;
  }
  if (isIdentifierStart(codePoint)) {
    return false;
  }
  return !doubleCharacterTokens.has(text.slice(position, position + 2))
    && !singleCharacterTokens.has(codePoint);
}

function isIdentifierStart(codePoint: number): boolean {
  return isAsciiLetter(codePoint)
    || codePoint === 0x5f
    || (codePoint > 0x7f && lookupInUnicodeMap(codePoint, unicodeIdentifierStartRanges));
}

function isIdentifierContinue(codePoint: number): boolean {
  return isAsciiLetter(codePoint)
    || isDecimalDigit(codePoint)
    || codePoint === 0x5f
    || (codePoint > 0x7f && lookupInUnicodeMap(codePoint, unicodeIdentifierContinueRanges));
}

function lookupInUnicodeMap(codePoint: number, ranges: readonly number[]): boolean {
  let low = 0;
  let high = ranges.length / 2;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const rangeStart = ranges[middle * 2]!;
    const rangeEnd = ranges[middle * 2 + 1]!;

    if (codePoint < rangeStart) {
      high = middle;
    } else if (codePoint > rangeEnd) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
}

function isAsciiLetter(codePoint: number): boolean {
  return (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a);
}

function isDecimalDigit(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function isHexDigit(codePoint: number): boolean {
  return isDecimalDigit(codePoint)
    || (codePoint >= 0x41 && codePoint <= 0x46)
    || (codePoint >= 0x61 && codePoint <= 0x66);
}

function isSurrogateCodeUnit(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
