import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CstKind, type CstElement, type CstNode } from "./cst.js";
import { lower } from "./lower.js";
import { parse } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import type { SyntaxToken } from "./token.js";

describe("parse", () => {
  it("builds closures with pattern parameters and a single arrow", () => {
    const result = parse("(item, _,) -> item.amount > 100");

    expect(result.diagnostics).toEqual([]);
    expect(descendantKinds(result.cst)).toContain(CstKind.ClosureExpression);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.ClosureParameter)).toHaveLength(2);
  });

  it("does not accept JavaScript's double-arrow closure spelling", () => {
    const result = parse("(value) => value");

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(descendantKinds(result.cst)).not.toContain(CstKind.ClosureExpression);
  });

  it("recovers a misspelled let keyword only when the following syntax proves a binding", () => {
    const source = "le fib = (x) -> x in fib";
    const result = parse(source);

    expect(result.diagnostics).toEqual([{
      code: "SF2009",
      category: "error",
      phase: "parse",
      message: "'le' is not valid before a binding. Did you mean 'let'?",
      range: { start: 0, end: 2 },
    }]);
    expect(descendantKinds(result.cst)).toContain(CstKind.LetExpression);
    expect(lower(result).program.expressions[0]).toMatchObject({
      kind: "LetExpression",
      bindings: [{ pattern: { kind: "IdentifierPattern", name: "fib" } }],
    });
    expect(reconstruct(result.cst, source)).toBe(source);

    expect(parse("le fib value").diagnostics).toEqual([]);
    for (const misspelling of ["lat", "lte", "lett"]) {
      expect(parse(`${misspelling} value = 1 in value`).diagnostics).toEqual([
        expect.objectContaining({ code: "SF2009", range: { start: 0, end: misspelling.length } }),
      ]);
    }
  });

  it("recovers a common logical-operator spelling without losing the surrounding expression", () => {
    const source = "let fib = (x) -> if x == 0 || x == 1 then 1 else fib(x - 1) + fib(x - 2) in print('Hello, meow')";
    const result = parse(source);
    const program = lower(result).program;

    expect(result.diagnostics).toEqual([{
      code: "SF2007",
      category: "error",
      phase: "parse",
      message: "'||' is not a logical operator. Use 'or' instead.",
      range: { start: 27, end: 29 },
    }]);
    expect(findElements(result.cst, "missing-token")).toEqual([]);
    expect(findElements(result.cst, "skipped-tokens")).toEqual([]);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.IfExpression)).toHaveLength(1);
    expect(descendantKinds(result.cst).filter((kind) => kind === CstKind.LetBinding)).toHaveLength(1);
    expect(program.expressions).toMatchObject([{
      kind: "LetExpression",
      bindings: [{ value: { kind: "ClosureExpression", body: { kind: "IfExpression" } } }],
      body: { kind: "CallExpression" },
    }]);
    expect(reconstruct(result.cst, source)).toBe(source);
    expect(flattenTokens(result.cst)).toEqual(result.tokens);
  });

  it("reports each recovered logical-operator spelling once", () => {
    const result = parse("if true && false then 1 else 0");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SF2007",
        message: "'&&' is not a logical operator. Use 'and' instead.",
        range: { start: 8, end: 10 },
      }),
    ]);
  });

  it("separates significant ranges from lossless full ranges", () => {
    const result = parse("  value  ");
    const expression = childNodes(result.cst)[0];

    expect(expression?.range).toEqual({ start: 2, end: 7 });
    expect(expression?.fullRange).toEqual({ start: 0, end: 7 });
    expect(result.cst.fullRange).toEqual({ start: 0, end: 9 });
  });

  it("parses postfix selectors and calls before infix operators", () => {
    const result = parse("a.b[c](d) + 1 * 2");

    expect(result.diagnostics).toEqual([]);
    expect(expressionShape(result.cst)).toEqual({
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
    const test = parse("value match 1");
    const selection = parse("value match { case 1 -> 'one' case n -> n else -> nil }");

    expect(test.diagnostics).toEqual([]);
    expect(selection.diagnostics).toEqual([]);
    expect(descendantKinds(test.cst)).toContain(CstKind.MatchTestExpression);
    expect(descendantKinds(selection.cst)).toEqual(expect.arrayContaining([
      CstKind.MatchSelectionExpression,
      CstKind.MatchCase,
      CstKind.MatchElse,
    ]));
  });

  it("preserves all source text and trailing separators in the CST token stream", () => {
    const source = "let even = (n,) -> odd(n - 1); odd = (n) -> even(n - 1) in [even, odd,] ;";
    const result = parse(source);

    expect(result.diagnostics).toEqual([]);
    expect(reconstruct(result.cst, source)).toBe(source);
  });

  it("inserts explicit missing tokens and continues after malformed input", () => {
    const result = parse("[1 2, 3; if true then 1]");

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(findElements(result.cst, "missing-token").length).toBeGreaterThan(0);
    expect(reconstruct(result.cst, result.source.toString())).toBe("[1 2, 3; if true then 1]");
  });

  it("treats an adjacent recognizable element as a missing separator", () => {
    const result = parse("[1 2]");
    const missing = findElements(result.cst, "missing-token");
    const array = lower(result).program.expressions[0];

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SF2004", message: "Expected ',' between array elements." }),
    ]);
    expect(missing).toMatchObject([{
      type: "missing-token",
      expectedKind: SyntaxKind.CommaToken,
      range: { start: 3, end: 3 },
    }]);
    expect(array).toMatchObject({ kind: "ArrayExpression", elements: [{ value: 1 }, { value: 2 }] });
  });

  it("preserves unexpected source tokens in explicit skipped-token groups", () => {
    const source = "[1 @ 2]";
    const result = parse(source);
    const skipped = findElements(result.cst, "skipped-tokens");
    const array = lower(result).program.expressions[0];

    expect(skipped).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SF1000", phase: "lex" }),
    ]);
    expect(skipped[0]).toMatchObject({
      type: "skipped-tokens",
      tokens: expect.arrayContaining([expect.objectContaining({ kind: SyntaxKind.UnknownToken })]),
    });
    expect(findElements(result.cst, "missing-token")).toEqual([]);
    expect(array).toMatchObject({ kind: "ArrayExpression", elements: [{ kind: "ErrorExpression" }] });
    expect(reconstruct(result.cst, source)).toBe(source);
    expect(flattenTokens(result.cst)).toEqual(result.tokens);
  });

  it("leaves outer separators for the enclosing context after a missing closer", () => {
    const cases = [
      { valid: "[1]; 2", closer: "]" },
      { valid: "{a: 1}; 2", closer: "}" },
      { valid: "f(1); 2", closer: ")" },
      { valid: "(1); 2", closer: ")" },
      { valid: "value[0]; 2", closer: "]" },
    ];

    for (const testCase of cases) {
      const source = testCase.valid.replace(testCase.closer, "");
      const result = parse(source);
      const expressions = childNodes(result.cst).filter((node) => isExpressionNode(node.kind));

      expect(result.diagnostics, source).toMatchObject([{ code: "SF2004" }]);
      expect(expressions, source).toHaveLength(2);
      expect(reconstruct(result.cst, source)).toBe(source);
    }
  });

  it("preserves a mismatched closer as skipped syntax behind one missing token", () => {
    const source = "f(1]";
    const result = parse(source);
    const missing = findElements(result.cst, "missing-token");
    const skipped = findElements(result.cst, "skipped-tokens");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SF2004", message: "Expected ')'.", range: { start: 3, end: 4 } }),
    ]);
    expect(missing).toMatchObject([{
      type: "missing-token",
      expectedKind: SyntaxKind.CloseParenToken,
      range: { start: 3, end: 3 },
    }]);
    expect(skipped).toMatchObject([{
      type: "skipped-tokens",
      tokens: [expect.objectContaining({ kind: SyntaxKind.CloseBracketToken })],
    }]);
    expect(reconstruct(result.cst, source)).toBe(source);
  });

  it("recovers nested lists at let and match boundaries without consuming the boundary", () => {
    const letResult = parse("let x = [1; y = 2 in y");
    const matchResult = parse("value match { case 1 -> f(0 case 2 -> 2 }");

    expect(letResult.diagnostics).toMatchObject([{ code: "SF2004", message: "Expected ']'." }]);
    expect(descendantKinds(letResult.cst).filter((kind) => kind === CstKind.LetBinding)).toHaveLength(2);
    expect(matchResult.diagnostics).toMatchObject([{ code: "SF2004", message: "Expected ')'." }]);
    expect(descendantKinds(matchResult.cst).filter((kind) => kind === CstKind.MatchCase)).toHaveLength(2);
  });

  it("bounds a missing closer to one diagnostic regardless of the following program length", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 500 }), (expressionCount) => {
        const valid = Array.from({ length: expressionCount }, () => "[1]").join("; ");
        const source = valid.replace("]", "");
        const result = parse(source);
        const expressions = childNodes(result.cst).filter((node) => isExpressionNode(node.kind));

        expect(result.diagnostics).toEqual([
          expect.objectContaining({ code: "SF2004", message: "Expected ']'." }),
        ]);
        expect(expressions).toHaveLength(expressionCount);
        expect(reconstruct(result.cst, source)).toBe(source);
      }),
      { numRuns: 100, seed: 0x51a61e },
    );
  });

  it("rejects an empty program and a trailing separator in a let group", () => {
    expect(parse("").diagnostics).toMatchObject([{ code: "SF2000" }]);
    expect(parse("let in nil").diagnostics).toMatchObject([{ code: "SF2000" }]);
    expect(parse("let x = 1; in x").diagnostics).toMatchObject([{ code: "SF2005" }]);
  });

  it("turns excessive nesting into a diagnostic rather than a host stack overflow", () => {
    const source = "(".repeat(2_000) + "1" + ")".repeat(2_000);
    const result = parse(source);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "SF2006" }),
    ]);
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
  let result = "";
  for (const child of node.children) {
    if (child.type === "token") {
      if (child.kind !== SyntaxKind.EndOfFileToken) {
        result += child.range.start === child.range.end ? "" : source.slice(child.range.start, child.range.end);
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

function descendantKinds(node: CstNode): readonly CstKind[] {
  const result: CstKind[] = [node.kind];
  for (const child of node.children) {
    if (child.type === "node") {
      result.push(...descendantKinds(child));
    }
  }
  return result;
}

interface ExpressionShape {
  readonly kind: CstKind;
  readonly children: readonly ExpressionShape[];
}

function expressionShape(node: CstNode): ExpressionShape {
  const expressions = childNodes(node).filter((child) => isExpressionNode(child.kind));
  if (node.kind === CstKind.Program && expressions[0] !== undefined) {
    return expressionShape(expressions[0]);
  }
  return { kind: node.kind, children: expressions.map(expressionShape) };
}

function childNodes(node: CstNode): CstNode[] {
  return node.children.filter((child): child is CstNode => child.type === "node");
}

function isExpressionNode(kind: CstKind): boolean {
  return kind >= CstKind.FirstExpression && kind <= CstKind.LastExpression;
}

function findElements(node: CstNode, type: CstElement["type"]): CstElement[] {
  const result: CstElement[] = [];
  for (const child of node.children) {
    if (child.type === type) {
      result.push(child);
    }
    if (child.type === "node") {
      result.push(...findElements(child, type));
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
