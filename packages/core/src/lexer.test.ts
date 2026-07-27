import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { lex } from "./lexer.js";
import { SyntaxKind } from "./syntax-kind.js";
import { tokenFullRange, TokenFlags, TriviaFlags, TriviaKind } from "./token.js";
import {
  unicodeIdentifierContinueRanges,
  unicodeIdentifierStartRanges,
} from "./unicode-identifier-ranges.generated.js";

describe("lex", () => {
  it("recognizes every first-version keyword and punctuation token", () => {
    const result = lex(
      "if else let fn match nil true false not and or "
      + "()[]{} ,;:. -> = == != < <= > >= + - * / %",
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => token.kind))
      .toEqual([
        SyntaxKind.IfKeyword,
        SyntaxKind.ElseKeyword,
        SyntaxKind.LetKeyword,
        SyntaxKind.FnKeyword,
        SyntaxKind.MatchKeyword,
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
    const result = lex("alpha Αλφα 数据 _value a\u0301 𐐀 case do then elif in");

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.filter((token) => token.kind === SyntaxKind.IdentifierToken).map((token) => token.value))
      .toEqual(["alpha", "Αλφα", "数据", "_value", "a\u0301", "𐐀", "case", "do", "then", "elif", "in"]);
  });

  it("keeps common unsupported logical-operator spellings as single tokens", () => {
    const result = lex("left && middle || right");

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.map((token) => token.kind))
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

  it("lexes line comments without consuming their line break", () => {
    const source = "value; // trailing\n// leading\nnext;";
    const result = lex(source);
    const semicolon = result.tokens.find((token) =>
      token.kind === SyntaxKind.SemicolonToken && token.range.start === 5
    );
    const next = result.tokens.find((token) => token.value === "next");

    expect(result.diagnostics).toEqual([]);
    expect(semicolon?.trailingTrivia.map((trivia) => trivia.kind)).toEqual([
      TriviaKind.Whitespace,
      TriviaKind.LineComment,
    ]);
    expect(semicolon?.trailingTrivia.map((trivia) => result.source.slice(trivia.range))).toEqual([
      " ",
      "// trailing",
    ]);
    expect(next?.leadingTrivia.map((trivia) => trivia.kind)).toEqual([
      TriviaKind.Whitespace,
      TriviaKind.LineComment,
      TriviaKind.Whitespace,
    ]);
    expect(next?.leadingTrivia.map((trivia) => result.source.slice(trivia.range))).toEqual([
      "\n",
      "// leading",
      "\n",
    ]);
  });

  it("nests block comments and keeps their delimiters in one trivia piece", () => {
    const source = "/* outer /* inner */ outer */ value;";
    const result = lex(source);
    const value = result.tokens[0];

    expect(result.diagnostics).toEqual([]);
    expect(value).toMatchObject({ kind: SyntaxKind.IdentifierToken, value: "value" });
    expect(value?.leadingTrivia).toHaveLength(2);
    expect(value?.leadingTrivia[0]).toMatchObject({
      kind: TriviaKind.BlockComment,
      flags: TriviaFlags.None,
      range: { start: 0, end: 29 },
    });
    expect(result.source.slice(value!.leadingTrivia[0]!.range)).toBe("/* outer /* inner */ outer */");
  });

  it("handles deeply nested block comments iteratively", () => {
    const depth = 2_000;
    const source = "/*".repeat(depth) + "inside" + "*/".repeat(depth) + "nil;";
    const result = lex(source);

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens[0]?.kind).toBe(SyntaxKind.NilKeyword);
    expect(result.tokens[0]?.leadingTrivia).toMatchObject([{
      kind: TriviaKind.BlockComment,
      flags: TriviaFlags.None,
      range: { start: 0, end: source.length - 4 },
    }]);
    expect(reconstruct(result)).toBe(source);
  });

  it("does not recognize comment delimiters inside string literals", () => {
    const source = String.raw`"// not a comment"; "/* neither */";`;
    const result = lex(source);

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.filter((token) => token.kind === SyntaxKind.StringLiteralToken)).toHaveLength(2);
    expect(result.tokens.flatMap((token) => [
      ...token.leadingTrivia,
      ...token.trailingTrivia,
    ])).toHaveLength(1);
    expect(reconstruct(result)).toBe(source);
  });

  it("keeps a multiline block comment trailing when it begins after a token on the same line", () => {
    const source = "left /* first\n /* nested */\n */ right;";
    const result = lex(source);
    const left = result.tokens[0];
    const right = result.tokens[1];

    expect(result.diagnostics).toEqual([]);
    expect(left?.trailingTrivia.map((trivia) => trivia.kind)).toEqual([
      TriviaKind.Whitespace,
      TriviaKind.BlockComment,
      TriviaKind.Whitespace,
    ]);
    expect(right?.leadingTrivia).toEqual([]);
    expect(result.source.slice(left!.trailingTrivia[1]!.range)).toBe("/* first\n /* nested */\n */");
  });

  it("assigns file-only and final detached comments to EOF", () => {
    const onlyComment = lex("// only");
    const detached = lex("value;\n\n/* final */");
    const onlyEof = onlyComment.tokens.at(-1);
    const detachedEof = detached.tokens.at(-1);

    expect(onlyEof?.kind).toBe(SyntaxKind.EndOfFileToken);
    expect(onlyEof?.leadingTrivia.map((trivia) => trivia.kind)).toEqual([
      TriviaKind.LineComment,
    ]);
    expect(detachedEof?.leadingTrivia.map((trivia) => trivia.kind)).toEqual([
      TriviaKind.Whitespace,
      TriviaKind.BlockComment,
    ]);
    expect(reconstruct(onlyComment)).toBe("// only");
    expect(reconstruct(detached)).toBe("value;\n\n/* final */");
  });

  it("reports one unterminated nested block comment through EOF", () => {
    const source = "value; /* outer /* inner */";
    const result = lex(source);
    const comment = result.tokens[1]?.trailingTrivia.find((trivia) =>
      trivia.kind === TriviaKind.BlockComment
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SF1008",
        message: "Unterminated block comment.",
        range: { start: 7, end: source.length },
      }),
    ]);
    expect(comment?.flags).toBe(TriviaFlags.Unterminated);
    expect(comment?.range).toEqual({ start: 7, end: source.length });
    expect(reconstruct(result)).toBe(source);
  });

  it("rejects unpaired UTF-16 surrogates inside comments without losing the comments", () => {
    const source = "// \ud800\n/* \udfff */ value;";
    const result = lex(source);

    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["SF1006", "SF1006"]);
    expect(reconstruct(result)).toBe(source);
    expect(result.tokens[0]?.leadingTrivia.map((trivia) => trivia.kind)).toEqual([
      TriviaKind.LineComment,
      TriviaKind.Whitespace,
      TriviaKind.BlockComment,
      TriviaKind.Whitespace,
    ]);
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
    .map((token) => result.source.slice(tokenFullRange(token)))
    .join("");
}

function significantKinds(source: string): SyntaxKind[] {
  return lex(source).tokens
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
    for (const trivia of token.leadingTrivia) {
      expect(trivia.range.start).toBe(position);
      expect(trivia.range.end).toBeGreaterThan(trivia.range.start);
      position = trivia.range.end;
    }

    expect(token.range.start).toBe(position);
    expect(token.range.end).toBeGreaterThanOrEqual(token.range.start);
    position = token.range.end;

    for (const trivia of token.trailingTrivia) {
      expect(trivia.range.start).toBe(position);
      expect(trivia.range.end).toBeGreaterThan(trivia.range.start);
      position = trivia.range.end;
    }

    expect(tokenFullRange(token)).toEqual({
      start: token.leadingTrivia[0]?.range.start ?? token.range.start,
      end: token.trailingTrivia.at(-1)?.range.end ?? token.range.end,
    });
  }
  expect(position).toBe(sourceLength);
}

function arbitraryUtf16String(maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength })
    .map((codeUnits) => String.fromCharCode(...codeUnits));
}
