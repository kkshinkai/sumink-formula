import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CstKind, type CstElement, type CstNode } from "./cst.js";
import { lower } from "./lower.js";
import { parse } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import type { SyntaxToken } from "./token.js";

describe("parse", () => {
  it("builds parenthesized and bare closures from the same closure node", () => {
    const result = parse("(item, _,) -> item.amount > 100; item -> item; (item -> item);");

    expect(result.diagnostics).toEqual([]);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.ClosureExpression)).toHaveLength(3);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.ClosureParameter)).toHaveLength(4);
  });

  it("does not accept a double-arrow closure spelling", () => {
    const result = parse("value => value;");

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(descendantKinds(result.cst)).not.toContain(CstKind.ClosureExpression);
  });

  it("accepts empty programs and preserves empty statements in the CST only", () => {
    const empty = parse("");
    const semicolons = parse(";;;;;;");

    expect(empty.diagnostics).toEqual([]);
    expect(semicolons.diagnostics).toEqual([]);
    expect(descendantKinds(semicolons.cst).filter((kind) => kind === CstKind.EmptyStatement)).toHaveLength(6);
    expect(lower(semicolons).program.statements).toEqual([]);
  });

  it("builds let, fn, and expression statements", () => {
    const result = parse("let x = 1; fn add(y) = x + y; add(2);");
    const program = lower(result).program;

    expect(result.diagnostics).toEqual([]);
    expect(program.statements).toMatchObject([
      { kind: "LetStatement", pattern: { kind: "IdentifierPattern", name: "x" } },
      { kind: "FnStatement", name: "add", parameters: [{ name: "y" }] },
      { kind: "ExpressionStatement", expression: { kind: "CallExpression" } },
    ]);
  });

  it("commits braces once using dictionary syntax as the discriminator", () => {
    const result = parse("{}; {;}; {;;;;}; {x}; {x;}; {name: 1}; {[key]: 2}; {[key]};");
    const kinds = childNodes(result.cst).map((statement) =>
      childNodes(statement).find((node) => isExpressionNode(node.kind))?.kind
    );

    expect(result.diagnostics).toEqual([]);
    expect(kinds).toEqual([
      CstKind.DictionaryExpression,
      CstKind.BlockExpression,
      CstKind.BlockExpression,
      CstKind.BlockExpression,
      CstKind.BlockExpression,
      CstKind.DictionaryExpression,
      CstKind.DictionaryExpression,
      CstKind.BlockExpression,
    ]);
  });

  it("does not reinterpret malformed braced syntax after choosing its form", () => {
    const malformedDictionary = parse("{name: 1; value};");
    const malformedBlock = parse("{name 1};");

    expect(descendantKinds(malformedDictionary.cst)).toContain(CstKind.DictionaryExpression);
    expect(descendantKinds(malformedDictionary.cst)).not.toContain(CstKind.BlockExpression);
    expect(malformedDictionary.diagnostics.length).toBeLessThanOrEqual(2);

    expect(descendantKinds(malformedBlock.cst)).toContain(CstKind.BlockExpression);
    expect(descendantKinds(malformedBlock.cst)).not.toContain(CstKind.DictionaryExpression);
    expect(malformedBlock.diagnostics.length).toBeLessThanOrEqual(2);
  });

  it("parses trailing braces as ordinary single-argument calls", () => {
    const result = parse("f {}; f {;}; f {name: 1}; f { x -> x } { 1 };");

    expect(result.diagnostics).toEqual([]);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.CallExpression)).toHaveLength(5);
    expect(descendantKinds(result.cst)).toEqual(expect.arrayContaining([
      CstKind.DictionaryExpression,
      CstKind.BlockExpression,
      CstKind.ClosureExpression,
    ]));
  });

  it("lowers parenthesized and braced arguments to the same call shape", () => {
    const parenthesized = lower(parse("f({});")).program.statements[0];
    const braced = lower(parse("f {};")).program.statements[0];

    expect(parenthesized).toMatchObject({
      kind: "ExpressionStatement",
      expression: {
        kind: "CallExpression",
        arguments: [{ kind: "DictionaryExpression", entries: [] }],
      },
    });
    expect(braced).toMatchObject({
      kind: "ExpressionStatement",
      expression: {
        kind: "CallExpression",
        arguments: [{ kind: "DictionaryExpression", entries: [] }],
      },
    });
  });

  it("requires parenthesized if conditions and keeps else optional", () => {
    const result = parse("if (first) 1; if (second) if (third) 2 else 3 else 4;");

    expect(result.diagnostics).toEqual([]);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.IfExpression)).toHaveLength(3);
  });

  it("parses postfix selectors and calls before infix operators", () => {
    const result = parse("a.b[c](d) + 1 * 2;");
    const expression = childNodes(childNodes(result.cst)[0]!)[0];

    expect(result.diagnostics).toEqual([]);
    expect(expressionShape(expression!)).toEqual({
      kind: CstKind.InfixOperatorExpression,
      children: [
        {
          kind: CstKind.CallExpression,
          children: [
            {
              kind: CstKind.ComputedSelectorExpression,
              children: [
                {
                  kind: CstKind.FieldSelectorExpression,
                  children: [{ kind: CstKind.IdentifierExpression, children: [] }],
                },
                { kind: CstKind.IdentifierExpression, children: [] },
              ],
            },
            { kind: CstKind.IdentifierExpression, children: [] },
          ],
        },
        {
          kind: CstKind.InfixOperatorExpression,
          children: [
            { kind: CstKind.LiteralExpression, children: [] },
            { kind: CstKind.LiteralExpression, children: [] },
          ],
        },
      ],
    });
  });

  it("parses subject-first match tests and selections", () => {
    const result = parse("value match 1; value match { case 1 -> 'one' case n -> n else -> nil };");

    expect(result.diagnostics).toEqual([]);
    expect(descendantKinds(result.cst)).toEqual(expect.arrayContaining([
      CstKind.MatchTestExpression,
      CstKind.MatchSelectionExpression,
      CstKind.MatchCase,
      CstKind.MatchElse,
    ]));
  });

  it("preserves all source text and trailing separators", () => {
    const source = "fn even(n,) = odd(n - 1); fn odd(n) = even(n - 1); [even, odd,];";
    const result = parse(source);

    expect(result.diagnostics).toEqual([]);
    expect(reconstruct(result.cst, source)).toBe(source);
    expect(flattenTokens(result.cst)).toEqual(result.tokens);
  });

  it("inserts missing separators and continues", () => {
    const result = parse("[1 2]; 3;");
    const missing = findElements(result.cst, "missing-token");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SF2004", message: "Expected ',' between array elements." }),
    ]);
    expect(missing).toMatchObject([{
      type: "missing-token",
      expectedKind: SyntaxKind.CommaToken,
      range: { start: 3, end: 3 },
    }]);
    expect(lower(result).program.statements[0]).toMatchObject({
      kind: "ExpressionStatement",
      expression: { kind: "ArrayExpression", elements: [{ value: 1 }, { value: 2 }] },
    });
  });

  it("preserves unexpected source tokens in skipped-token groups", () => {
    const source = "[1 @ 2];";
    const result = parse(source);

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF1000", phase: "lex" })]);
    expect(findElements(result.cst, "skipped-tokens")).toHaveLength(1);
    expect(reconstruct(result.cst, source)).toBe(source);
    expect(flattenTokens(result.cst)).toEqual(result.tokens);
  });

  it("leaves an outer statement terminator to the enclosing context", () => {
    for (const valid of ["[1]; 2;", "{a: 1}; 2;", "f(1); 2;", "(1); 2;", "value[0]; 2;"]) {
      const closer = valid.includes("[") ? "]" : valid.includes("{") ? "}" : ")";
      const source = valid.replace(closer, "");
      const result = parse(source);

      expect(result.diagnostics, source).toMatchObject([{ code: "SF2004" }]);
      expect(childNodes(result.cst).filter((node) => isStatementNode(node.kind)), source).toHaveLength(2);
      expect(reconstruct(result.cst, source)).toBe(source);
    }
  });

  it("bounds a missing closer independently of the following program length", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 300 }), (statementCount) => {
        const source = Array.from({ length: statementCount }, () => "[1];").join(" ").replace("]", "");
        const result = parse(source);

        expect(result.diagnostics).toEqual([
          expect.objectContaining({ code: "SF2004", message: "Expected ']'." }),
        ]);
        expect(childNodes(result.cst).filter((node) => isStatementNode(node.kind))).toHaveLength(statementCount);
      }),
      { numRuns: 60, seed: 0x51a61e },
    );
  });

  it("turns excessive nesting into a diagnostic rather than a host overflow", () => {
    const source = "(".repeat(2_000) + "1" + ")".repeat(2_000) + ";";
    const result = parse(source);

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SF2006" })]);
    expect(findElements(result.cst, "skipped-tokens")).toHaveLength(1);
    expect(reconstruct(result.cst, source)).toBe(source);
  });

  it("terminates and remains lossless for arbitrary token sequences", () => {
    const alphabet = "abc_012[]{}(),;:.+-*/%=<>@#?&|!~^\\ '\"\n";
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...alphabet), { maxLength: 64 }).map((characters) => characters.join("")),
        (source) => {
          const result = parse(source);
          expect(reconstruct(result.cst, source)).toBe(source);
          expect(flattenTokens(result.cst)).toEqual(result.tokens);
        },
      ),
      { numRuns: 1_000, seed: 0x3adc0ffe },
    );
  });
});

function reconstruct(node: CstNode, source: string): string {
  return node.children.map((child) => {
    if (child.type === "node") {
      return reconstruct(child, source);
    }
    if (child.type === "skipped-tokens") {
      return child.tokens
        .filter((token) => token.kind !== SyntaxKind.EndOfFileToken)
        .map((token) => source.slice(token.range.start, token.range.end))
        .join("");
    }
    return child.type === "token" && child.kind !== SyntaxKind.EndOfFileToken
      ? source.slice(child.range.start, child.range.end)
      : "";
  }).join("");
}

function flattenTokens(node: CstNode): SyntaxToken[] {
  return node.children.flatMap((child): SyntaxToken[] => {
    if (child.type === "node") {
      return flattenTokens(child);
    }
    if (child.type === "skipped-tokens") {
      return [...child.tokens];
    }
    return child.type === "token" ? [child] : [];
  });
}

function childNodes(node: CstNode): CstNode[] {
  return node.children.filter((child): child is CstNode => child.type === "node");
}

function descendantKinds(node: CstNode): CstKind[] {
  return [node.kind, ...childNodes(node).flatMap(descendantKinds)];
}

function expressionShape(node: CstNode): { readonly kind: CstKind; readonly children: readonly unknown[] } {
  return {
    kind: node.kind,
    children: childNodes(node).filter((child) => isExpressionNode(child.kind)).map(expressionShape),
  };
}

function isStatementNode(kind: CstKind): boolean {
  return kind >= CstKind.FirstStatement && kind <= CstKind.LastStatement;
}

function isExpressionNode(kind: CstKind): boolean {
  return kind >= CstKind.FirstExpression && kind <= CstKind.LastExpression;
}

function findElements<T extends CstElement["type"]>(
  node: CstNode,
  type: T,
): Extract<CstElement, { readonly type: T }>[] {
  const result: Extract<CstElement, { readonly type: T }>[] = [];
  for (const child of node.children) {
    if (child.type === type) {
      result.push(child as Extract<CstElement, { readonly type: T }>);
    }
    if (child.type === "node") {
      result.push(...findElements(child, type));
    }
  }
  return result;
}
