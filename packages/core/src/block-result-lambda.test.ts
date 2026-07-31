import { describe, expect, it } from "vitest";

import { CstKind, isCstNode, type CstElement, type CstNode } from "./cst.js";
import { analyzeExpression, interpretExpression } from "./interpreter.js";
import { lowerExpression } from "./lower.js";
import { parseExpression } from "./parser.js";
import { isFunctionValue, nativeFunction, type RuntimeValue } from "./runtime-value.js";
import { tokenFullRange } from "./token.js";

describe("block-result lambdas", () => {
  it("makes the remainder of the enclosing block the lambda body", () => {
    const source = "{ x -> print(x); x + 1 }";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;
    const closure = requiredDescendant(parsed.cst, CstKind.ClosureExpression);
    const blockBody = requiredDescendant(parsed.cst, CstKind.ClosureBlockBody);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.source.slice(closure.range)).toBe("x -> print(x); x + 1");
    expect(parsed.source.slice(blockBody.range)).toBe("print(x); x + 1");
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      statements: [],
      result: {
        kind: "ClosureExpression",
        parameters: [{ kind: "IdentifierPattern", name: "x" }],
        body: {
          kind: "BlockExpression",
          statements: [{
            kind: "ExpressionStatement",
            expression: {
              kind: "CallExpression",
              callee: { kind: "IdentifierExpression", name: "print" },
              arguments: [{ kind: "IdentifierExpression", name: "x" }],
            },
          }],
          result: {
            kind: "InfixOperatorExpression",
            operator: "+",
            left: { kind: "IdentifierExpression", name: "x" },
            right: { kind: "LiteralExpression", value: 1 },
          },
        },
      },
    });
  });

  it("leaves statements before the arrow in the outer block", () => {
    const source = "{ setup(); x -> use(x); finish(x) }";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;
    const analysis = analyzeExpression(source);
    const closure = requiredDescendant(parsed.cst, CstKind.ClosureExpression);

    expect(parsed.diagnostics).toEqual([]);
    expect([...analysis.resolution.dependencies]).toEqual(["setup", "use", "finish"]);
    expect(parsed.source.slice(closure.range)).toBe("x -> use(x); finish(x)");
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      statements: [{
        kind: "ExpressionStatement",
        expression: {
          kind: "CallExpression",
          callee: { kind: "IdentifierExpression", name: "setup" },
        },
      }],
      result: {
        kind: "ClosureExpression",
        parameters: [{ kind: "IdentifierPattern", name: "x" }],
        body: {
          kind: "BlockExpression",
          statements: [{
            kind: "ExpressionStatement",
            expression: {
              kind: "CallExpression",
              callee: { kind: "IdentifierExpression", name: "use" },
            },
          }],
          result: {
            kind: "CallExpression",
            callee: { kind: "IdentifierExpression", name: "finish" },
          },
        },
      },
    });

    const events: string[] = [];
    const created = interpretExpression(source, {
      globals: {
        setup: nativeFunction(() => {
          events.push("setup");
          return null;
        }, { name: "setup", arity: 0 }),
        use: nativeFunction(({ arguments: [value = null] }) => {
          events.push(`use:${String(value)}`);
          return null;
        }, { name: "use", arity: 1 }),
        finish: nativeFunction(({ arguments: [value = null] }) => {
          events.push(`finish:${String(value)}`);
          return typeof value === "number" ? value + 1 : null;
        }, { name: "finish", arity: 1 }),
      },
    });

    expect(created.analysis.diagnostics).toEqual([]);
    expect(created.evaluation).toMatchObject({ ok: true });
    if (created.evaluation?.ok !== true || !isFunctionValue(created.evaluation.value)) {
      throw new Error("Expected the outer block to produce a closure.");
    }
    expect(events).toEqual(["setup"]);

    const invoked = interpretExpression("closure(41)", {
      globals: { closure: created.evaluation.value },
    });

    expect(invoked.analysis.diagnostics).toEqual([]);
    expect(invoked.evaluation).toMatchObject({ ok: true, value: 42 });
    expect(events).toEqual(["setup", "use:41", "finish:41"]);
  });

  it("nests a returned block-result lambda instead of ending the outer one", () => {
    const source = "{ x -> note(x); y -> note(y); x + y }";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;

    expect(parsed.diagnostics).toEqual([]);
    expect(descendants(parsed.cst, CstKind.ClosureBlockBody)).toHaveLength(2);
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      result: {
        kind: "ClosureExpression",
        parameters: [{ kind: "IdentifierPattern", name: "x" }],
        body: {
          kind: "BlockExpression",
          statements: [{ kind: "ExpressionStatement" }],
          result: {
            kind: "ClosureExpression",
            parameters: [{ kind: "IdentifierPattern", name: "y" }],
            body: {
              kind: "BlockExpression",
              statements: [{ kind: "ExpressionStatement" }],
              result: { kind: "InfixOperatorExpression", operator: "+" },
            },
          },
        },
      },
    });

    const events: RuntimeValue[] = [];
    const note = nativeFunction(({ arguments: [value = null] }) => {
      events.push(value);
      return null;
    }, { name: "note", arity: 1 });
    const result = interpretExpression(`(${source})(2)(3)`, { globals: { note } });

    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({ ok: true, value: 5 });
    expect(events).toEqual([2, 3]);
  });

  it("keeps an ordinary lambda outside a braced block expression-bodied", () => {
    const parsed = parseExpression("x -> x + 1");
    const expression = lowerExpression(parsed).expression;

    expect(parsed.diagnostics).toEqual([]);
    expect(descendants(parsed.cst, CstKind.ClosureBlockBody)).toEqual([]);
    expect(expression).toMatchObject({
      kind: "ClosureExpression",
      parameters: [{ kind: "IdentifierPattern", name: "x" }],
      body: { kind: "InfixOperatorExpression", operator: "+" },
    });
    expect(expression).not.toMatchObject({
      body: { kind: "BlockExpression" },
    });
  });

  it("applies the same rule inside an ordinary trailing braced argument", () => {
    const source = "{ fn apply(f) = f(3); apply { x -> tap(x); x + 1 } }";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;

    expect(parsed.diagnostics).toEqual([]);
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      result: {
        kind: "CallExpression",
        callee: { kind: "IdentifierExpression", name: "apply" },
        arguments: [{
          kind: "BlockExpression",
          result: {
            kind: "ClosureExpression",
            body: {
              kind: "BlockExpression",
              statements: [{ kind: "ExpressionStatement" }],
              result: { kind: "InfixOperatorExpression", operator: "+" },
            },
          },
        }],
      },
    });

    const events: RuntimeValue[] = [];
    const tap = nativeFunction(({ arguments: [value = null] }) => {
      events.push(value);
      return null;
    }, { name: "tap", arity: 1 });
    const result = interpretExpression(source, { globals: { tap } });

    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({ ok: true, value: 4 });
    expect(events).toEqual([3]);
  });

  it("allows a block-result lambda with an empty nil-returning body", () => {
    const source = "{ x -> }";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;
    const result = interpretExpression(`(${source})(42)`);

    expect(parsed.diagnostics).toEqual([]);
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      result: {
        kind: "ClosureExpression",
        parameters: [{ kind: "IdentifierPattern", name: "x" }],
        body: {
          kind: "BlockExpression",
          statements: [],
        },
      },
    });
    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({ ok: true, value: null });
  });

  it("supports parenthesized parameters and declarations in the block body", () => {
    const source = [
      "({ (left, right) ->",
      "  let sum = left + right;",
      "  fn double(value) = value * 2;",
      "  double(sum)",
      "})(20, 1)",
    ].join("\n");
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;
    const result = interpretExpression(source);

    expect(parsed.diagnostics).toEqual([]);
    expect(expression).toMatchObject({
      kind: "CallExpression",
      callee: {
        kind: "GroupedExpression",
        expression: {
          kind: "BlockExpression",
          result: {
            kind: "ClosureExpression",
            parameters: [
              { kind: "IdentifierPattern", name: "left" },
              { kind: "IdentifierPattern", name: "right" },
            ],
            body: {
              kind: "BlockExpression",
              statements: [
                { kind: "LetStatement" },
                { kind: "FnStatement", name: "double" },
              ],
              result: { kind: "CallExpression" },
            },
          },
        },
      },
    });
    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({ ok: true, value: 42 });
  });

  it("allows grouping to keep a lambda as an outer expression statement", () => {
    const source = "{ (x -> x + 1); 42 }";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;
    const result = interpretExpression(source);

    expect(parsed.diagnostics).toEqual([]);
    expect(descendants(parsed.cst, CstKind.ClosureBlockBody)).toEqual([]);
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      statements: [{
        kind: "ExpressionStatement",
        expression: {
          kind: "GroupedExpression",
          expression: {
            kind: "ClosureExpression",
            body: { kind: "InfixOperatorExpression", operator: "+" },
          },
        },
      }],
      result: { kind: "LiteralExpression", value: 42 },
    });
    expect(result.evaluation).toMatchObject({ ok: true, value: 42 });
  });

  it("keeps the lambda body intact while recovering a missing outer brace", () => {
    const source = "{ setup(); x -> use(x); finish(x)";
    const parsed = parseExpression(source);
    const expression = lowerExpression(parsed).expression;
    const closure = requiredDescendant(parsed.cst, CstKind.ClosureExpression);

    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ code: "SF2004", message: "Expected '}'." }),
    ]);
    expect(reconstruct(parsed.cst, source)).toBe(source);
    expect(parsed.source.slice(closure.range)).toBe("x -> use(x); finish(x)");
    expect(expression).toMatchObject({
      kind: "BlockExpression",
      statements: [{ kind: "ExpressionStatement" }],
      result: {
        kind: "ClosureExpression",
        body: {
          kind: "BlockExpression",
          statements: [{ kind: "ExpressionStatement" }],
          result: { kind: "CallExpression" },
        },
      },
    });
  });
});

function descendants(node: CstNode, kind: CstKind): CstNode[] {
  const result: CstNode[] = [];
  for (const child of node.children) {
    if (!isCstNode(child)) {
      continue;
    }
    if (child.kind === kind) {
      result.push(child);
    }
    result.push(...descendants(child, kind));
  }
  return result;
}

function requiredDescendant(node: CstNode, kind: CstKind): CstNode {
  const matches = descendants(node, kind);
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) {
    throw new Error(`Expected CST kind ${kind}.`);
  }
  return match;
}

function reconstruct(node: CstNode, source: string): string {
  return node.children.map((child: CstElement) => {
    if (child.type === "node") {
      return reconstruct(child, source);
    }
    if (child.type === "skipped-tokens") {
      return child.tokens.map((token) => {
        const range = tokenFullRange(token);
        return source.slice(range.start, range.end);
      }).join("");
    }
    if (child.type === "missing-token") {
      return "";
    }
    const range = tokenFullRange(child);
    return source.slice(range.start, range.end);
  }).join("");
}
