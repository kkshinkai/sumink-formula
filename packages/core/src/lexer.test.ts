import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { lex } from "./lexer.js";
import { SyntaxKind } from "./syntax-kind.js";
import { TokenFlags } from "./token.js";
import {
  unicodeIdentifierContinueRanges,
  unicodeIdentifierStartRanges,
} from "./unicode-identifier-ranges.generated.js";

describe("lex", () => {
  it("recognizes every first-version keyword and punctuation token", () => {
    const result = lex(
      "if else let fn match case nil true false not and or "
      + "()[]{} ,;:. -> = == != < <= > >= + - * / %",
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.filter((token) => token.kind !== SyntaxKind.WhitespaceTrivia).map((token) => token.kind))
      .toEqual([
        SyntaxKind.IfKeyword,
        SyntaxKind.ElseKeyword,
        SyntaxKind.LetKeyword,
        SyntaxKind.FnKeyword,
        SyntaxKind.MatchKeyword,
        SyntaxKind.CaseKeyword,
        SyntaxKind.NilKeyword,
        SyntaxKind.TrueKeyword,
        SyntaxKind.FalseKeyword,
        SyntaxKind.NotKeyword,
        SyntaxKind.AndKeyword,
        SyntaxKind.OrKeyword,
        SyntaxKind.OpenParenToken,
        SyntaxKind.CloseParenToken,
        SyntaxKind.OpenBracketToken,
        SyntaxKind.CloseBracketToken,
        SyntaxKind.OpenBraceToken,
        SyntaxKind.CloseBraceToken,
        SyntaxKind.CommaToken,
        SyntaxKind.SemicolonToken,
        SyntaxKind.ColonToken,
        SyntaxKind.DotToken,
        SyntaxKind.ArrowToken,
        SyntaxKind.EqualsToken,
        SyntaxKind.EqualsEqualsToken,
        SyntaxKind.BangEqualsToken,
        SyntaxKind.LessThanToken,
        SyntaxKind.LessThanEqualsToken,
        SyntaxKind.GreaterThanToken,
        SyntaxKind.GreaterThanEqualsToken,
        SyntaxKind.PlusToken,
        SyntaxKind.MinusToken,
        SyntaxKind.AsteriskToken,
        SyntaxKind.SlashToken,
        SyntaxKind.PercentToken,
        SyntaxKind.EndOfFileToken,
      ]);
  });

  it("supports Unicode identifiers without assigning meaning to letter case", () => {
    const result = lex("alpha Αλφα 数据 _value a\u0301 𐐀 do then elif in");

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.filter((token) => token.kind === SyntaxKind.IdentifierToken).map((token) => token.value))
      .toEqual(["alpha", "Αλφα", "数据", "_value", "a\u0301", "𐐀", "do", "then", "elif", "in"]);
  });

  it("keeps common unsupported logical-operator spellings as single tokens", () => {
    const result = lex("left && middle || right");

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.filter((token) => token.kind !== SyntaxKind.WhitespaceTrivia).map((token) => token.kind))
      .toEqual([
        SyntaxKind.IdentifierToken,
        SyntaxKind.AmpersandAmpersandToken,
        SyntaxKind.IdentifierToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.IdentifierToken,
        SyntaxKind.EndOfFileToken,
      ]);
  });

  it("coalesces an unsupported punctuation run into one lexical error", () => {
    const result = lex("@@@ value");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SF1000",
        message: "Unexpected token \"@@@\".",
        range: { start: 0, end: 3 },
      }),
    ]);
    expect(result.tokens[0]).toMatchObject({
      kind: SyntaxKind.UnknownToken,
      range: { start: 0, end: 3 },
    });
  });

  it("uses the pinned Unicode identifier tables for start and continuation", () => {
    const combiningMark = lex("\u0301");
    const emoji = lex("😀");

    expect(combiningMark.tokens[0]?.kind).toBe(SyntaxKind.UnknownToken);
    expect(emoji.tokens[0]?.kind).toBe(SyntaxKind.UnknownToken);
  });

  it("recognizes every boundary in the generated Unicode identifier maps", () => {
    expectRangeMap(
      unicodeIdentifierStartRanges,
      (codePoint) => {
        const source = String.fromCodePoint(codePoint);
        expect(significantKinds(source)).toEqual([
          SyntaxKind.IdentifierToken,
          SyntaxKind.EndOfFileToken,
        ]);
      },
      (codePoint) => {
        expect(lex(String.fromCodePoint(codePoint)).tokens[0]?.kind)
          .not.toBe(SyntaxKind.IdentifierToken);
      },
    );

    expectRangeMap(
      unicodeIdentifierContinueRanges,
      (codePoint) => {
        const source = `a${String.fromCodePoint(codePoint)}`;
        const identifiers = lex(source).tokens.filter(
          (token) => token.kind === SyntaxKind.IdentifierToken,
        );
        expect(identifiers).toHaveLength(1);
        expect(identifiers[0]?.value).toBe(source);
      },
      (codePoint) => {
        expect(lex(`a${String.fromCodePoint(codePoint)}`).tokens[0]?.value).toBe("a");
      },
    );
  });

  it("decodes string escapes while preserving raw source spans", () => {
    const source = String.raw`"a\n\u03bb" 'it\'s'`;
    const result = lex(source);
    const strings = result.tokens.filter((token) => token.kind === SyntaxKind.StringLiteralToken);

    expect(result.diagnostics).toEqual([]);
    expect(strings.map((token) => token.value)).toEqual(["a\nλ", "it's"]);
    expect(strings.map((token) => result.source.slice(token.range))).toEqual([
      String.raw`"a\n\u03bb"`,
      String.raw`'it\'s'`,
    ]);
  });

  it("reports malformed numbers and strings without losing input", () => {
    const source = "01 1e+ \"open\nnext";
    const result = lex(source);

    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["SF1001", "SF1002", "SF1003"]);
    expect(reconstruct(result)).toBe(source);
    expect(result.tokens.some((token) => (token.flags & TokenFlags.Unterminated) !== 0)).toBe(true);
  });

  it("accepts escaped surrogate pairs but rejects unpaired escaped surrogates", () => {
    expect(lex(String.raw`"\uD83D\uDE00"`).diagnostics).toEqual([]);
    expect(lex(String.raw`"\uD800"`).diagnostics).toMatchObject([{ code: "SF1005" }]);
  });

  it("rejects raw control characters forbidden by the string grammar", () => {
    const result = lex("\"tab\tcharacter\"");

    expect(result.diagnostics).toMatchObject([{ code: "SF1007" }]);
    expect(result.tokens[0]?.flags ?? TokenFlags.None).toBe(
      TokenFlags.ContainsInvalidCharacter,
    );
    expect(reconstruct(result)).toBe("\"tab\tcharacter\"");
  });

  it("is lossless for arbitrary UTF-16 input", () => {
    fc.assert(
      fc.property(arbitraryUtf16String(48), (source) => {
        const result = lex(source);
        expect(reconstruct(result)).toBe(source);
        expectTokenPartition(result, source.length);
      }),
      { numRuns: 2_000, seed: 0x6d2b79f5 },
    );
  });
});

function reconstruct(result: ReturnType<typeof lex>): string {
  return result.tokens
    .filter((token) => token.kind !== SyntaxKind.EndOfFileToken)
    .map((token) => result.source.slice(token.range))
    .join("");
}

function significantKinds(source: string): SyntaxKind[] {
  return lex(source).tokens
    .filter((token) => token.kind !== SyntaxKind.WhitespaceTrivia)
    .map((token) => token.kind);
}

function expectRangeMap(
  ranges: readonly number[],
  assertBoundary: (codePoint: number) => void,
  assertGap: (codePoint: number) => void,
): void {
  expect(ranges.length % 2).toBe(0);

  let previousEnd = -1;
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index]!;
    const end = ranges[index + 1]!;

    expect(start).toBeGreaterThan(previousEnd);
    expect(end).toBeGreaterThanOrEqual(start);
    if (previousEnd + 1 < start) {
      assertGap(previousEnd + 1);
    }
    assertBoundary(start);
    assertBoundary(end);
    previousEnd = end;
  }

  if (previousEnd < 0x10ffff) {
    assertGap(previousEnd + 1);
  }
}

function expectTokenPartition(result: ReturnType<typeof lex>, sourceLength: number): void {
  let position = 0;
  for (const token of result.tokens) {
    expect(token.range.start).toBe(position);
    expect(token.range.end).toBeGreaterThanOrEqual(token.range.start);
    position = token.range.end;
  }
  expect(position).toBe(sourceLength);
}

function arbitraryUtf16String(maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength })
    .map((codeUnits) => String.fromCharCode(...codeUnits));
}
