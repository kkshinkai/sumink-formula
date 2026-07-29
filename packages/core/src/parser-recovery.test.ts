import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CstKind, isCstNode, type CstElement, type CstNode } from "./cst.js";
import { lex } from "./lexer.js";
import { parse, parseFileModule } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import { tokenFullRange, type SyntaxToken } from "./token.js";

interface RecoveryFixture {
  readonly name: string;
  readonly source: string;
  readonly preservedKinds: readonly CstKind[];
  readonly root?: "file-module";
}

const lexicalErrorFixtures: readonly RecoveryFixture[] = [
  {
    name: "module declarations",
    source: "import local.{x as y, *}; export module nested { export let value = 1 @ 2; }",
    preservedKinds: [
      CstKind.FileModule,
      CstKind.ImportDeclaration,
      CstKind.ExportDeclaration,
      CstKind.ModuleDeclaration,
      CstKind.ModulePath,
      CstKind.ImportSelectorList,
      CstKind.ImportSelector,
      CstKind.WildcardImportSelector,
    ],
    root: "file-module",
  },
  {
    name: "statement coverage",
    source: "; let _ = 1; fn f(1, _) = @;",
    preservedKinds: [CstKind.EmptyStatement, CstKind.LetStatement, CstKind.FnStatement, CstKind.WildcardPattern],
  },
  {
    name: "error pattern",
    source: "let @ = 1; let value = 2;",
    preservedKinds: [CstKind.LetStatement, CstKind.ErrorPattern],
  },
  { name: "program", source: "1 @ 2; 3;", preservedKinds: [CstKind.Program, CstKind.ExpressionStatement] },
  {
    name: "operator forms",
    source: "not source transform value + 1 @ 2;",
    preservedKinds: [
      CstKind.PrefixOperatorExpression,
      CstKind.InfixCallExpression,
      CstKind.InfixOperatorExpression,
    ],
  },
  { name: "array element", source: "[1 @ 2, 3];", preservedKinds: [CstKind.ArrayExpression] },
  { name: "dictionary value", source: "{a: 1 @ 2, b: 3};", preservedKinds: [CstKind.DictionaryExpression] },
  {
    name: "shorthand dictionary entry",
    source: "{item, value: 1 @ 2};",
    preservedKinds: [CstKind.DictionaryExpression, CstKind.ShorthandDictionaryEntry],
  },
  {
    name: "computed dictionary key",
    source: "{[1 @ 2]: 3, b: 4};",
    preservedKinds: [CstKind.DictionaryExpression, CstKind.ComputedDictionaryKey],
  },
  { name: "call argument", source: "f(1 @ 2, 3);", preservedKinds: [CstKind.CallExpression] },
  { name: "grouped expression", source: "(1 @ 2);", preservedKinds: [CstKind.GroupedExpression] },
  { name: "closure body", source: "x -> x @ 1;", preservedKinds: [CstKind.ClosureExpression] },
  { name: "block expression", source: "{ 1 @ 2; 3 };", preservedKinds: [CstKind.BlockExpression] },
  { name: "if condition", source: "if (true @ false) 1 else 0;", preservedKinds: [CstKind.IfExpression] },
  { name: "if branch", source: "if (true) @ 1 else 0;", preservedKinds: [CstKind.IfExpression] },
  { name: "else branch", source: "if (true) 1 else @ 0;", preservedKinds: [CstKind.IfExpression] },
  {
    name: "let value",
    source: "let x = 1 @ 2; let y = 3;",
    preservedKinds: [CstKind.LetStatement],
  },
  {
    name: "let equals",
    source: "let x @ 1; let y = 2;",
    preservedKinds: [CstKind.LetStatement],
  },
  {
    name: "fn body",
    source: "fn f(x) = x @ 1; fn g() = 2;",
    preservedKinds: [CstKind.FnStatement, CstKind.ClosureParameter],
  },
  { name: "field selector", source: "value.@field;", preservedKinds: [CstKind.FieldSelectorExpression] },
  { name: "computed selector", source: "value[1 @ 2];", preservedKinds: [CstKind.ComputedSelectorExpression] },
  { name: "match test", source: "value match @ 1;", preservedKinds: [CstKind.MatchTestExpression] },
  {
    name: "match selection opener",
    source: "value match @ { 1 -> 1, 2 -> 2 };",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchArm],
  },
  {
    name: "match pattern",
    source: "value match { @ -> 1, 2 -> 2 };",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchArm],
  },
  {
    name: "match arrow",
    source: "value match { 1 @ 1, 2 -> 2 };",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchArm],
  },
  {
    name: "match result",
    source: "value match { 1 -> 1 @ 2, 2 -> 2, _ -> 0 };",
    preservedKinds: [CstKind.MatchSelectionExpression, CstKind.MatchArm],
  },
];

const validGrammarFixtures = [
  ";;;;;;",
  "nil; true; false; 1; 'text';",
  "1 + 2 * 3 == 7 and not false;",
  "values map transform;",
  "[1, 2, 3,];",
  "{item,}; {item, value, a: 1, 'b': 2, 3: 'three', [key]: 3,};",
  "f(1, 2,); f { x -> x };",
  "(1 + 2);",
  "(x, y,) -> x + y; x -> x;",
  "(_) -> nil;",
  "{;}; {1}; {1;};",
  "if (true) 1 else if (false) 2 else 3;",
  "let x = 1; let y = z -> z; y(x);",
  "fn even(n) = odd(n - 1); fn odd(n) = even(n - 1); even(4);",
  "value.field[key];",
  "value match 1;",
  "value match { 1 -> 'one', x -> x, _ -> nil, };",
] as const;

const validFileModuleFixtures = [
  `
    import geometry.{area, unit as length, hidden as _, *};
    import geometry as geo;
    import {point, vector as direction, excluded as _, *} from "./vector.sumi";
    import vector from "./vector.sumi";
    export let origin = [0, 0];
    export fn distance(a, b) = a - b;
    export module shapes { export fn square(size) = size * size; }
    export geometry.{area, unit as exportedUnit, *};
  `,
] as const;

describe("parser recovery contract", () => {
  it("leaves a following declaration for statement-level terminator recovery", () => {
    const result = parse("let value = 1 let other = 2;");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SF2004",
        message: "Expected ';' after the statement.",
      }),
    ]);
    expect(result.cst.children
      .filter(isCstNode)
      .map((node) => node.kind)).toEqual([CstKind.LetStatement, CstKind.LetStatement]);
  });

  it("requires every CST kind in both the valid and malformed corpora", () => {
    const validKinds = new Set<CstKind>();
    const malformedKinds = new Set<CstKind>();

    for (const source of validGrammarFixtures) {
      descendantKinds(parse(source).cst).forEach((kind) => validKinds.add(kind));
    }
    for (const source of validFileModuleFixtures) {
      descendantKinds(parseFileModule(source).cst).forEach((kind) => validKinds.add(kind));
    }
    for (const fixture of lexicalErrorFixtures) {
      descendantKinds(parseFixture(fixture).cst).forEach((kind) => malformedKinds.add(kind));
    }

    const missingValidKinds: CstKind[] = [];
    const missingMalformedKinds: CstKind[] = [];
    for (let kind = CstKind.Program; kind <= CstKind.LastPattern; kind += 1) {
      if (
        kind !== CstKind.ErrorExpression
        && kind !== CstKind.ErrorPattern
        && !validKinds.has(kind)
      ) {
        missingValidKinds.push(kind);
      }
      if (!malformedKinds.has(kind)) {
        missingMalformedKinds.push(kind);
      }
    }
    expect(missingValidKinds, "Every CST kind needs a valid fixture.").toEqual([]);
    expect(missingMalformedKinds, "Every CST kind needs a malformed recovery fixture.").toEqual([]);
  });

  for (const fixture of lexicalErrorFixtures) {
    it(`owns one lexical error without cascading through ${fixture.name}`, () => {
      const result = parseFixture(fixture);
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
    const result = parse("[1 @ 2, 3 @ 4];");

    expect(result.diagnostics).toMatchObject([
      { code: "SF1000", range: { start: 3, end: 4 } },
      { code: "SF1000", range: { start: 10, end: 11 } },
    ]);
  });

  it("does not synchronize at separators nested inside a malformed region", () => {
    const source = "[1 @ f(2, 3), 4];";
    const result = parse(source);
    const skipped = collectElements(result.cst, "skipped-tokens");

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF1000" })]);
    expect(skipped).toHaveLength(1);
    expect(source.slice(skipped[0]?.range.start, skipped[0]?.range.end)).toBe("@ f(2, 3)");
  });

  it("lets an else boundary terminate a malformed region with an unmatched delimiter", () => {
    const source = "if (true) 1 @ f(1 else 3;";
    const result = parse(source);

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF1000" })]);
    expect(descendantKinds(result.cst)).toContain(CstKind.IfExpression);
    expect(reconstruct(result.cst, source)).toBe(source);
  });

  it("bounds every single-token edit across every first-version syntax fixture", () => {
    for (const source of validGrammarFixtures) {
      expect(parse(source).diagnostics, source).toEqual([]);

      const tokens = lex(source).tokens.filter((token) =>
        token.kind !== SyntaxKind.EndOfFileToken
      );
      for (const token of tokens) {
        for (const edited of [
          replaceRange(source, token.range.start, token.range.end, "@"),
          replaceRange(source, token.range.start, token.range.end, ""),
          replaceRange(source, token.range.start, token.range.start, "@ "),
        ]) {
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

  it("makes diagnostic count independent of a valid suffix size", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (size) => {
        const suffix = Array.from({ length: size }, (_, index) => `let x${index} = ${index};`).join(" ");
        const sources = [
          `if (true @ false) 1 else 2; ${suffix}`,
          `let x = 1 @ 2; ${suffix}`,
          `value match { 0 -> 0 @ 1, 1 -> 1, _ -> nil }; ${suffix}`,
          `[1 @ 2, ${Array.from({ length: size }, () => "3").join(", ")}];`,
          `{a: 1 @ 2, b: 3}; ${suffix}`,
          `{ let local = 1 @ 2; local }; ${suffix}`,
        ];

        for (const source of sources) {
          expect(parse(source).diagnostics, source).toEqual([
            expect.objectContaining({ code: "SF1000", phase: "lex" }),
          ]);
        }
      }),
      { numRuns: 20, seed: 0x5eedc0de },
    );
  });
});

function parseFixture(fixture: RecoveryFixture) {
  return fixture.root === "file-module"
    ? parseFileModule(fixture.source)
    : parse(fixture.source);
}

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
      const range = tokenFullRange(child);
      result += source.slice(range.start, range.end);
    } else if (child.type === "skipped-tokens") {
      for (const token of child.tokens) {
        const range = tokenFullRange(token);
        result += source.slice(range.start, range.end);
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
