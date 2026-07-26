import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Expression, NodeId, Pattern, Program } from "./ast.js";
import type { CstNode } from "./cst.js";
import { analyze } from "./interpreter.js";
import { parse } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import type { SyntaxToken } from "./token.js";

describe("grammar conformance", () => {
  it.each([
    ["literal expressions", "nil; true; false; 0; 42; 3.14; 1e6; 1E-6; 'text'; \"text\";"],
    ["array expressions", "[]; [1]; [1, 2, 3,];"],
    ["object expressions", "{}; {name: 'Ada'}; {'name': 1, [key]: 2,};"],
    ["ordinary calls", "function(); function(1); function(1, 2,);"],
    ["infix calls", "source transform closure map mapper"],
    ["grouped expressions", "(1 + 2) * 3"],
    ["closures", "() -> nil; (value) -> value; (1, _, name,) -> name;"],
    ["blocks", "do {}; do {1}; do {1; 2;};"],
    ["conditionals", "if a then b elif c then d elif e then f else g"],
    ["operators", "not false or -1 + 2 * 3 <= 8 and 4 != 5"],
    ["selectors", "root.field[index][2].leaf"],
    ["let groups", "let first = 1; second = () -> first in second()"],
    ["match tests", "value match 1; value match _;"],
    ["match selections", "value match { case 0 -> 'zero' case x -> x else -> nil }"],
  ])("accepts every approved %s form", (_description, source) => {
    expect(analyze(source).diagnostics).toEqual([]);
  });

  it("assigns every semantic node exactly one unique identity", () => {
    const analysis = analyze(
      "let make = (x) -> () -> x; value = make(input) in "
      + "value() match { case 0 -> {kind: 'zero'} case n -> {[kind]: n} }",
    );
    const ids = collectNodeIds(analysis.program);

    expect(analysis.diagnostics).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every diagnostic inside the source range for arbitrary malformed input", () => {
    fc.assert(
      fc.property(arbitraryUtf16String(80), (source) => {
        const result = parse(source);
        expect(reconstructCst(result.cst, source)).toBe(source);
        expect(flattenCstTokens(result.cst)).toEqual(result.tokens);
        const diagnosticKeys = new Set<string>();
        for (const entry of result.diagnostics) {
          expect(entry.range.start).toBeGreaterThanOrEqual(0);
          expect(entry.range.end).toBeGreaterThanOrEqual(entry.range.start);
          expect(entry.range.end).toBeLessThanOrEqual(source.length);
          const key = `${entry.code}:${entry.range.start}:${entry.range.end}:${entry.message}`;
          expect(diagnosticKeys.has(key)).toBe(false);
          diagnosticKeys.add(key);
          for (const related of entry.relatedInformation ?? []) {
            expect(related.range.start).toBeGreaterThanOrEqual(0);
            expect(related.range.end).toBeGreaterThanOrEqual(related.range.start);
            expect(related.range.end).toBeLessThanOrEqual(source.length);
          }
        }
      }),
      { numRuns: 1_000, seed: 0x51a6e },
    );
  });
});

function collectNodeIds(program: Program): NodeId[] {
  const ids: NodeId[] = [program.id];
  program.expressions.forEach((expression) => collectExpression(expression, ids));
  return ids;
}

function collectExpression(expression: Expression, ids: NodeId[]): void {
  ids.push(expression.id);
  switch (expression.kind) {
    case "ErrorExpression":
    case "LiteralExpression":
    case "IdentifierExpression":
      return;
    case "ArrayExpression":
      expression.elements.forEach((child) => collectExpression(child, ids));
      return;
    case "ObjectExpression":
      expression.members.forEach((member) => {
        ids.push(member.id);
        if (member.key.kind === "ComputedObjectKey") {
          collectExpression(member.key.expression, ids);
        }
        collectExpression(member.value, ids);
      });
      return;
    case "CallExpression":
      collectExpression(expression.callee, ids);
      expression.arguments.forEach((child) => collectExpression(child, ids));
      return;
    case "GroupedExpression":
      collectExpression(expression.expression, ids);
      return;
    case "ClosureExpression":
      expression.parameters.forEach((pattern) => collectPattern(pattern, ids));
      collectExpression(expression.body, ids);
      return;
    case "BlockExpression":
      expression.expressions.forEach((child) => collectExpression(child, ids));
      return;
    case "IfExpression":
      expression.branches.forEach((branch) => {
        collectExpression(branch.condition, ids);
        collectExpression(branch.result, ids);
      });
      collectExpression(expression.elseBranch, ids);
      return;
    case "PrefixOperatorExpression":
      collectExpression(expression.operand, ids);
      return;
    case "InfixOperatorExpression":
      collectExpression(expression.left, ids);
      collectExpression(expression.right, ids);
      return;
    case "FieldSelectorExpression":
      collectExpression(expression.receiver, ids);
      return;
    case "ComputedSelectorExpression":
      collectExpression(expression.receiver, ids);
      collectExpression(expression.selector, ids);
      return;
    case "LetExpression":
      expression.bindings.forEach((binding) => {
        ids.push(binding.id);
        collectPattern(binding.pattern, ids);
        collectExpression(binding.value, ids);
      });
      collectExpression(expression.body, ids);
      return;
    case "MatchTestExpression":
      collectExpression(expression.subject, ids);
      collectPattern(expression.pattern, ids);
      return;
    case "MatchSelectionExpression":
      collectExpression(expression.subject, ids);
      expression.cases.forEach((matchCase) => {
        ids.push(matchCase.id);
        collectPattern(matchCase.pattern, ids);
        collectExpression(matchCase.result, ids);
      });
      if (expression.elseBranch !== undefined) {
        collectExpression(expression.elseBranch, ids);
      }
      return;
  }
}

function collectPattern(pattern: Pattern, ids: NodeId[]): void {
  ids.push(pattern.id);
}

function arbitraryUtf16String(maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength })
    .map((codeUnits) => String.fromCharCode(...codeUnits));
}

function reconstructCst(node: CstNode, source: string): string {
  return node.children.map((child) => {
    if (child.type === "node") {
      return reconstructCst(child, source);
    }
    if (child.type === "skipped-tokens") {
      return child.tokens
        .filter((token) => token.kind !== SyntaxKind.EndOfFileToken)
        .map((token) => source.slice(token.range.start, token.range.end))
        .join("");
    }
    if (child.type === "token" && child.kind !== SyntaxKind.EndOfFileToken) {
      return source.slice(child.range.start, child.range.end);
    }
    return "";
  }).join("");
}

function flattenCstTokens(node: CstNode): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  for (const child of node.children) {
    if (child.type === "node") {
      tokens.push(...flattenCstTokens(child));
    } else if (child.type === "skipped-tokens") {
      tokens.push(...child.tokens);
    } else if (child.type === "token") {
      tokens.push(child);
    }
  }
  return tokens;
}
