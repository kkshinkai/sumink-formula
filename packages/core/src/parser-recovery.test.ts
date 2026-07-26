import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CstKind, type CstElement, type CstNode } from "./cst.js";
import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import type { SyntaxToken } from "./token.js";

interface RecoveryFixture {
  readonly name: string;
  readonly source: string;
  readonly preservedKinds: readonly CstKind[];
}

const lexicalErrorFixtures: readonly RecoveryFixture[] = [
  { name: "program", source: "1 @ 2; 3", preservedKinds: [CstKind.Program] },
  { name: "array element", source: "[1 @ 2, 3]", preservedKinds: [CstKind.ArrayExpression] },
  { name: "object value", source: "{a: 1 @ 2, b: 3}", preservedKinds: [CstKind.ObjectExpression] },
  {
    name: "computed object key",
    source: "{[1 @ 2]: 3, b: 4}",
    preservedKinds: [CstKind.ObjectExpression, CstKind.ComputedObjectKey],
  },
  { name: "call argument", source: "f(1 @ 2, 3)", preservedKinds: [CstKind.CallExpression] },
  { name: "grouped expression", source: "(1 @ 2)", preservedKinds: [CstKind.GroupedExpression] },
  { name: "closure body", source: "(x) -> x @ 1", preservedKinds: [CstKind.ClosureExpression] },
  { name: "block expression", source: "do { 1 @ 2; 3 }", preservedKinds: [CstKind.BlockExpression] },
  { name: "if condition", source: "if true @ false then 1 else 0", preservedKinds: [CstKind.IfExpression] },
  { name: "if branch", source: "if true then @ 1 else 0", preservedKinds: [CstKind.IfExpression] },
  {
    name: "elif condition",
    source: "if true then 1 elif false @ true then 2 else 3",
    preservedKinds: [CstKind.IfExpression, CstKind.ElifClause],
  },
  {
    name: "elif branch",
    source: "if true then 1 elif false then 2 @ 3 else 4",
    preservedKinds: [CstKind.IfExpression, CstKind.ElifClause],
  },
  { name: "else branch", source: "if true then 1 else @ 0", preservedKinds: [CstKind.IfExpression] },
  {
    name: "let binding value",
    source: "let x = 1 @ 2; y = 3 in y",
    preservedKinds: [CstKind.LetExpression, CstKind.LetBinding],
  },
  {
    name: "let binding equals",
    source: "let x @ 1; y = 2 in y",
    preservedKinds: [CstKind.LetExpression, CstKind.LetBinding],
  },
  { name: "field selector", source: "value.@field", preservedKinds: [CstKind.FieldSelectorExpression] },
  {
    name: "computed selector",
    source: "value[1 @ 2]",
    preservedKinds: [CstKind.ComputedSelectorExpression],
  },
  { name: "match test", source: "value match @ 1", preservedKinds: [CstKind.MatchTestExpression] },
  {
    name: "match selection opener",
    source: "value match @ case 1 -> 1 case 2 -> 2 }",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchCase],
  },
  {
    name: "match pattern",
    source: "value match { case @ -> 1 case 2 -> 2 }",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchCase],
  },
  {
    name: "match arrow",
    source: "value match { case 1 @ 1 case 2 -> 2 }",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchCase],
  },
  {
    name: "match result",
    source: "value match { case 1 -> 1 @ 2 case 2 -> 2 else -> 0 }",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchCase, CstKind.MatchElse],
  },
];

const validGrammarFixtures = [
  "nil; true; false; 1; 'text'",
  "1 + 2 * 3 == 7 and not false",
  "values map transform",
  "[1, 2, 3,]",
  "{a: 1, 'b': 2, [key]: 3,}",
  "f(1, 2,)",
  "(1 + 2)",
  "(x, y,) -> x + y",
  "(_) -> nil",
  "do { 1; 2; }",
  "if true then 1 elif false then 2 else 3",
  "let x = 1; y = (z) -> z in y(x)",
  "value.field[key]",
  "value match 1",
  "value match { case 1 -> 'one' case x -> x else -> nil }",
  "let even = (n) -> odd(n - 1); odd = (n) -> even(n - 1) in even(4)",
] as const;

describe("parser recovery contract", () => {
  it("requires every CST kind to participate in the recovery corpus", () => {
    const coveredKinds = new Set<CstKind>();

    for (const source of validGrammarFixtures) {
      for (const kind of descendantKinds(parse(source).cst)) {
        coveredKinds.add(kind);
      }
    }
    for (const fixture of lexicalErrorFixtures) {
      for (const kind of descendantKinds(parse(fixture.source).cst)) {
        coveredKinds.add(kind);
      }
    }

    const uncoveredKinds: CstKind[] = [];
    for (let kind = CstKind.Program; kind <= CstKind.LastPattern; kind += 1) {
      if (!coveredKinds.has(kind)) {
        uncoveredKinds.push(kind);
      }
    }
    expect(
      uncoveredKinds,
      "Every new CST kind needs a valid or malformed recovery fixture before it can ship.",
    ).toEqual([]);
  });

  for (const fixture of lexicalErrorFixtures) {
    it(`owns one lexical error without cascading through ${fixture.name}`, () => {
      const result = parse(fixture.source);
      const kinds = descendantKinds(result.cst);

      expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF1000", phase: "lex" })]);
      for (const kind of fixture.preservedKinds) {
        expect(kinds, `CST kind ${kind}`).toContain(kind);
      }
      expect(reconstruct(result.cst, fixture.source)).toBe(fixture.source);
      expect(flattenTokens(result.cst)).toEqual(result.tokens);
    });
  }

  it("keeps separate malformed regions diagnostically independent", () => {
    const result = parse("[1 @ 2, 3 @ 4]");

    expect(result.diagnostics).toMatchObject([
      { code: "SF1000", range: { start: 3, end: 4 } },
      { code: "SF1000", range: { start: 10, end: 11 } },
    ]);
  });

  it("does not synchronize at separators nested inside a malformed region", () => {
    const source = "[1 @ f(2, 3), 4]";
    const result = parse(source);
    const skipped = collectElements(result.cst, "skipped-tokens");

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF1000" })]);
    expect(skipped).toHaveLength(1);
    expect(source.slice(skipped[0]?.range.start, skipped[0]?.range.end)).toBe("@ f(2, 3)");
    expect(descendantKinds(result.cst)).toContain(CstKind.ArrayExpression);
  });

  it("lets a control boundary terminate a malformed region with an unmatched delimiter", () => {
    const source = "if true @ f(1 then 2 else 3";
    const result = parse(source);

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF1000" })]);
    expect(descendantKinds(result.cst)).toContain(CstKind.IfExpression);
    expect(reconstruct(result.cst, source)).toBe(source);
  });

  it("bounds every single-token edit across every first-version syntax fixture", () => {
    for (const source of validGrammarFixtures) {
      const original = parse(source);
      expect(original.diagnostics, source).toEqual([]);

      const tokens = lex(source).tokens.filter((token) =>
        token.kind !== SyntaxKind.WhitespaceTrivia && token.kind !== SyntaxKind.EndOfFileToken
      );
      for (const token of tokens) {
        const edits = [
          replaceRange(source, token.range.start, token.range.end, "@"),
          replaceRange(source, token.range.start, token.range.end, ""),
          replaceRange(source, token.range.start, token.range.start, "@ "),
        ];
        for (const edited of edits) {
          const result = parse(edited);
          expect(
            result.diagnostics.length,
            `${JSON.stringify(source)} became ${JSON.stringify(edited)}`,
          ).toBeLessThanOrEqual(3);
          expect(reconstruct(result.cst, edited)).toBe(edited);
          expect(flattenTokens(result.cst)).toEqual(result.tokens);
        }
      }
    }
  });

  it("makes diagnostic count independent of the valid suffix size", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), (size) => {
        const sources = [
          `if true @ false then 1 else ${Array.from({ length: size }, () => "1").join(" + ")}`,
          `let x = 1 @ 2; ${Array.from({ length: size }, (_, index) => `x${index} = ${index}`).join("; ")} in x0`,
          `value match { case 0 -> 0 @ 1 ${Array.from({ length: size }, (_, index) => `case ${index + 1} -> ${index + 1}`).join(" ")} else -> nil }`,
          `[1 @ 2, ${Array.from({ length: size }, () => "3").join(", ")}]`,
        ];

        for (const source of sources) {
          expect(parse(source).diagnostics, source).toEqual([
            expect.objectContaining({ code: "SF1000", phase: "lex" }),
          ]);
        }
      }),
      { numRuns: 25, seed: 0x5eedc0de },
    );
  });
});

function replaceRange(source: string, start: number, end: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(end);
}

function descendantKinds(node: CstNode): CstKind[] {
  const result: CstKind[] = [node.kind];
  for (const child of node.children) {
    if (child.type === "node") {
      result.push(...descendantKinds(child));
    }
  }
  return result;
}

function reconstruct(node: CstNode, source: string): string {
  let result = "";
  for (const child of node.children) {
    if (child.type === "token") {
      if (child.kind !== SyntaxKind.EndOfFileToken) {
        result += source.slice(child.range.start, child.range.end);
      }
    } else if (child.type === "skipped-tokens") {
      for (const token of child.tokens) {
        if (token.kind !== SyntaxKind.EndOfFileToken) {
          result += source.slice(token.range.start, token.range.end);
        }
      }
    } else if (child.type === "node") {
      result += reconstruct(child, source);
    }
  }
  return result;
}

function flattenTokens(node: CstNode): SyntaxToken[] {
  const result: SyntaxToken[] = [];
  for (const child of node.children) {
    if (child.type === "token") {
      result.push(child);
    } else if (child.type === "skipped-tokens") {
      result.push(...child.tokens);
    } else if (child.type === "node") {
      result.push(...flattenTokens(child));
    }
  }
  return result;
}

function collectElements<T extends CstElement["type"]>(
  node: CstNode,
  type: T,
): Extract<CstElement, { readonly type: T }>[] {
  const result: Extract<CstElement, { readonly type: T }>[] = [];
  for (const child of node.children) {
    if (child.type === type) {
      result.push(child as Extract<CstElement, { readonly type: T }>);
    }
    if (child.type === "node") {
      result.push(...collectElements(child, type));
    }
  }
  return result;
}
