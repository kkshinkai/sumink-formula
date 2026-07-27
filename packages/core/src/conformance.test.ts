import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Expression, NodeId, Pattern, Program, Statement } from "./ast.js";
import type { CstNode } from "./cst.js";
import { analyze } from "./interpreter.js";
import { parse } from "./parser.js";
import { SyntaxKind } from "./syntax-kind.js";
import { tokenFullRange, type SyntaxToken } from "./token.js";

describe("grammar conformance", () => {
  it.each([
    ["empty statements", ";;;;;;"],
    ["literal expressions", "nil; true; false; 0; 42; 3.14; 1e6; 1E-6; 'text'; \"text\";"],
    ["array expressions", "[]; [1]; [1, 2, 3,];"],
    ["dictionary expressions", "{}; {name: 'Ada'}; {'name': 1, 2: 'two', [key]: 2,};"],
    ["ordinary calls", "function(); function(1); function(1, 2,);"],
    ["trailing brace calls", "function {}; function {;}; function { x -> x };"],
    ["infix calls", "source transform closure map mapper;"],
    ["grouped expressions", "(1 + 2) * 3;"],
    ["closures", "() -> nil; value -> value; (value) -> value; (1, _, name,) -> name;"],
    ["blocks", "{;}; {;;;;}; {1}; {1;}; {let x = 1; x};"],
    ["conditionals", "if (a) b; if (a) b else if (c) d else e;"],
    ["operators", "not false or -1 + 2 * 3 <= 8 and 4 != 5;"],
    ["selectors", "root.field[index][2].leaf;"],
    ["let statements", "let first = 1; let second = () -> first; second();"],
    ["fn statements", "fn first(x) = second(x); fn second(x) = x; first(1);"],
    ["match tests", "value match 1; value match _;"],
    ["match selections", "value match { case 0 -> 'zero' case x -> x else -> nil };"],
    ["comments", "// line\n1; /* outer /* nested */ outer */ 2;"],
  ])("accepts every approved %s form", (_description, source) => {
    expect(analyze(source).diagnostics).toEqual([]);
  });

  it("assigns every semantic node exactly one unique identity", () => {
    const analysis = analyze([
      "let make = x -> () -> x;",
      "let value = make(input);",
      "value() match { case 0 -> {kind: 'zero'} case n -> {[kind]: n} };",
    ].join(" "));
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
  program.statements.forEach((statement) => collectStatement(statement, ids));
  return ids;
}

function collectStatement(statement: Statement, ids: NodeId[]): void {
  ids.push(statement.id);
  switch (statement.kind) {
    case "LetStatement":
      collectPattern(statement.pattern, ids);
      collectExpression(statement.value, ids);
      return;
    case "FnStatement":
      statement.parameters.forEach((pattern) => collectPattern(pattern, ids));
      collectExpression(statement.body, ids);
      return;
    case "ExpressionStatement":
      collectExpression(statement.expression, ids);
      return;
  }
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
    case "DictionaryExpression":
      expression.entries.forEach((entry) => {
        ids.push(entry.id);
        collectExpression(entry.key, ids);
        collectExpression(entry.value, ids);
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
      expression.statements.forEach((statement) => collectStatement(statement, ids));
      if (expression.result !== undefined) {
        collectExpression(expression.result, ids);
      }
      return;
    case "IfExpression":
      collectExpression(expression.condition, ids);
      collectExpression(expression.consequent, ids);
      if (expression.alternative !== undefined) {
        collectExpression(expression.alternative, ids);
      }
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
        .map((token) => {
          const range = tokenFullRange(token);
          return source.slice(range.start, range.end);
        })
        .join("");
    }
    if (child.type !== "token") {
      return "";
    }
    const range = tokenFullRange(child);
    return source.slice(range.start, range.end);
  }).join("");
}

function flattenCstTokens(node: CstNode): SyntaxToken[] {
  return node.children.flatMap((child): SyntaxToken[] => {
    if (child.type === "node") {
      return flattenCstTokens(child);
    }
    if (child.type === "skipped-tokens") {
      return [...child.tokens];
    }
    return child.type === "token" ? [child] : [];
  });
}
