import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CstKind, type CstNode } from "./cst.js";
import { lower, lowerFileModule } from "./lower.js";
import { parse, parseFileModule } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import { tokenFullRange } from "./token.js";

describe("module syntax", () => {
  it("parses every import and export form into explicit semantic nodes", () => {
    const source = `
      import geometry.{point, length as size, hidden as _, *};
      import geometry as geo;
      import {length, normalize as unitVector, internal as _, *} from "./vector.sumi";
      import vector from "./vector.sumi";
      export let origin = [0, 0];
      export fn distance(a, b) = length(a - b);
      export module shapes { export fn square(size) = size * size; }
      export vector.{length, normalize as normalizeVector};
    `;
    const parsed = parseFileModule(source);
    const fileModule = lowerFileModule(parsed).fileModule;

    expect(parsed.diagnostics).toEqual([]);
    expect(fileModule.items).toMatchObject([
      {
        kind: "ImportDeclaration",
        modulePath: { segments: [{ name: "geometry" }] },
        clause: {
          kind: "MemberImportClause",
          selectors: [
            { kind: "NamedImportSelector", importedName: "point", excluded: false },
            { kind: "NamedImportSelector", importedName: "length", localName: "size" },
            { kind: "NamedImportSelector", importedName: "hidden", excluded: true },
            { kind: "WildcardImportSelector" },
          ],
        },
      },
      {
        kind: "ImportDeclaration",
        modulePath: { segments: [{ name: "geometry" }] },
        clause: { kind: "ModuleAliasImportClause", localName: "geo" },
      },
      {
        kind: "ImportDeclaration",
        source: "./vector.sumi",
        clause: { kind: "MemberImportClause" },
      },
      {
        kind: "ImportDeclaration",
        source: "./vector.sumi",
        clause: { kind: "ModuleAliasImportClause", localName: "vector" },
      },
      { kind: "ExportDeclaration", declaration: { kind: "LetStatement" } },
      { kind: "ExportDeclaration", declaration: { kind: "FnStatement", name: "distance" } },
      {
        kind: "ExportDeclaration",
        declaration: { kind: "ModuleDeclaration", name: "shapes" },
      },
      {
        kind: "ExportDeclaration",
        modulePath: { segments: [{ name: "vector" }] },
      },
    ]);
    expect(reconstruct(parsed.cst, source)).toBe(source);
  });

  it("uses distinct executable Program and declaration-only File Module roots", () => {
    const program = parse("module local { export let value = 1; } import local.{value}; value;");
    const fileModule = parseFileModule("export let value = 1;");
    const invalidFileModule = parseFileModule("1 + 2;");
    const invalidProgram = parse("export let value = 1;");

    expect(program.diagnostics).toEqual([]);
    expect(program.cst.kind).toBe(CstKind.Program);
    expect(lower(program).program.items).toMatchObject([
      { kind: "ModuleDeclaration" },
      { kind: "ImportDeclaration" },
      { kind: "ExpressionStatement" },
    ]);
    expect(fileModule.diagnostics).toEqual([]);
    expect(fileModule.cst.kind).toBe(CstKind.FileModule);
    expect(invalidFileModule.diagnostics).toEqual([
      expect.objectContaining({ message: "Expected a module declaration." }),
    ]);
    expect(invalidProgram.diagnostics).toEqual([
      expect.objectContaining({ message: "Expected a program item." }),
    ]);
  });

  it("classifies module words as keywords without affecting longer identifiers", () => {
    const result = parse("imported; exported; fromValue; aside; modular;");
    const keywordResult = parseFileModule(
      "import source.{value as renamed}; export module nested {}",
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.tokens.filter((token) => token.kind === SyntaxKind.IdentifierToken)).toHaveLength(5);
    expect(keywordResult.tokens.map((token) => token.kind)).toEqual(expect.arrayContaining([
      SyntaxKind.ImportKeyword,
      SyntaxKind.AsKeyword,
      SyntaxKind.ExportKeyword,
      SyntaxKind.ModuleKeyword,
    ]));
  });

  it("recovers malformed module lists without losing following declarations", () => {
    const source = `
      import source.{first second, * later};
      export let valid = 1;
      module nested { export fn okay() = 2; }
    `;
    const result = parseFileModule(source);
    const kinds = descendants(result.cst);

    expect(result.diagnostics.length).toBeLessThanOrEqual(4);
    expect(kinds).toEqual(expect.arrayContaining([
      CstKind.ImportDeclaration,
      CstKind.ExportDeclaration,
      CstKind.LetStatement,
      CstKind.ModuleDeclaration,
      CstKind.FnStatement,
    ]));
    expect(reconstruct(result.cst, source)).toBe(source);
  });

  it("is lossless and never throws for arbitrary File Module source", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (source) => {
        const result = parseFileModule(source);
        expect(reconstruct(result.cst, source)).toBe(source);
      }),
      { numRuns: 1_000, seed: 0x4d4f4455 },
    );
  });
});

function descendants(node: CstNode): CstKind[] {
  return [
    node.kind,
    ...node.children.flatMap((child): CstKind[] =>
      child.type === "node" ? descendants(child) : []
    ),
  ];
}

function reconstruct(node: CstNode, source: string): string {
  return node.children.map((child) => {
    if (child.type === "node") return reconstruct(child, source);
    if (child.type === "missing-token") return "";
    if (child.type === "skipped-tokens") {
      return child.tokens.map((token) => source.slice(
        tokenFullRange(token).start,
        tokenFullRange(token).end,
      )).join("");
    }
    const range = tokenFullRange(child);
    return source.slice(range.start, range.end);
  }).join("");
}
