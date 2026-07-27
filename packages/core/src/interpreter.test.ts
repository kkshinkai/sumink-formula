import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { analyze, interpret } from "./interpreter.js";
import {
  arrayValue,
  dictionaryValue,
  getDictionaryEntry,
  isArrayValue,
  isDictionaryValue,
  isFunctionValue,
  nativeFunction,
  runtimeEquals,
  type RuntimeValue,
} from "./runtime-value.js";

describe("statements and lexical closures", () => {
  it("evaluates programs for effects and returns nil", () => {
    const events: RuntimeValue[] = [];
    const tap = nativeFunction(({ arguments: [value = null] }) => {
      events.push(value);
      return value;
    }, { name: "tap", arity: 1 });

    const result = interpret(";;; tap(1); tap(2); ;", { globals: { tap } });

    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({ ok: true, value: null });
    expect(events).toEqual([1, 2]);
  });

  it("treats nested comments as trivia at every expression boundary", () => {
    expectExpression([
      "/* before */ {",
      "let value /* name */ = /* value */ 40;",
      "fn add(/* parameter */ amount) = value + amount; // body",
      "add(/* argument /* nested */ */ 2)",
      "} /* after */",
    ].join("\n"), 42);
  });

  it("uses lexical rather than dynamic scope under shadowing", () => {
    expectExpression("{ let x = 1; let f = () -> x; { let x = 2; f() } }", 1);
  });

  it("keeps captured environments alive after the creating call returns", () => {
    expectExpression("{ let make = x -> () -> x; let f = make(41); f() + 1 }", 42);
  });

  it("keeps an escaped closure valid in another evaluation", () => {
    const closure = expressionValue("() -> source", { source: 41 });
    const result = expressionValue("closure()", { closure, source: 99 });

    expect(result).toBe(41);
  });

  it("keeps an escaped fn closure valid in another evaluation", () => {
    const closure = expressionValue("{ fn read() = source; read }", { source: 41 });
    const result = expressionValue("closure()", { closure, source: 99 });

    expect(result).toBe(41);
  });

  it("creates a separate captured parameter frame for every invocation", () => {
    expectExpression(
      "{ let make = x -> () -> x; let a = make(1); let b = make(2); [a(), b()] }",
      arrayValue([1, 2]),
    );
  });

  it("keeps let sequential, non-hoisted, and non-recursive", () => {
    const self = analyze("let f = x -> f(x); f(0);");
    const forward = analyze("let first = second; let second = 2; first;");

    expect([...self.resolution.dependencies]).toEqual(["f"]);
    expect([...forward.resolution.dependencies]).toEqual(["second"]);
  });

  it("supports direct and mutual recursion through hoisted fn bindings", () => {
    expectExpression(
      "{ fn factorial(n) = if (n == 0) 1 else n * factorial(n - 1); factorial(7) }",
      5_040,
    );
    expectExpression([
      "{",
      "fn even(n) = if (n == 0) true else odd(n - 1);",
      "fn odd(n) = if (n == 0) false else even(n - 1);",
      "even(30)",
      "}",
    ].join(" "), true);
  });

  it("supports a three-function recursion cycle independently of declaration order", () => {
    expectExpression([
      "{",
      "fn c(n) = if (n == 0) 'c' else a(n - 1);",
      "fn a(n) = if (n == 0) 'a' else b(n - 1);",
      "fn b(n) = if (n == 0) 'b' else c(n - 1);",
      "a(5)",
      "}",
    ].join(" "), "c");
  });

  it("keeps an escaped mutually recursive fn group alive", () => {
    expectExpression([
      "{",
      "let functions = {",
      "fn even(n) = if (n == 0) true else odd(n - 1);",
      "fn odd(n) = if (n == 0) false else even(n - 1);",
      "{even: even, odd: odd}",
      "};",
      "functions.even(20)",
      "}",
    ].join(" "), true);
  });

  it("makes prior lets visible to fn bodies but not later lets", () => {
    expectExpression("{ let value = 42; fn read() = value; read() }", 42);

    const analysis = analyze("{ fn read() = value; let value = 42; read() }");
    expect([...analysis.resolution.dependencies]).toEqual(["value"]);
  });

  it("reports an early call that reaches a not-yet-initialized captured let", () => {
    const result = interpret([
      "read();",
      "let value = 42;",
      "fn read() = value;",
    ].join(" "));

    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4005", phase: "evaluate" },
    });
  });

  it("diagnoses duplicate let and fn bindings in one scope", () => {
    const duplicateLet = analyze("let x = 1; let x = 2;");
    const mixed = analyze("fn x() = nil; let x = 1;");

    for (const analysis of [duplicateLet, mixed]) {
      expect(analysis.resolution.diagnostics).toHaveLength(1);
      expect(analysis.resolution.diagnostics[0]).toMatchObject({ code: "SF3000", phase: "resolve" });
      expect(analysis.resolution.diagnostics[0]?.relatedInformation).toHaveLength(1);
    }
  });

  it("reports let pattern failure without creating a binding", () => {
    const result = interpret("let 1 = 2;");

    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4007", phase: "evaluate" },
    });
  });
});

describe("blocks, lambdas, and calls", () => {
  it("distinguishes a block tail from a terminated expression", () => {
    expectExpression("{;}", null);
    expectExpression("{;;;;;;}", null);
    expectExpression("{1}", 1);
    expectExpression("{1;}", null);
    expectExpression("{;; 1}", 1);
  });

  it("accepts ordinary bare single-pattern lambdas everywhere", () => {
    expectExpression("(x -> x + 1)(2)", 3);
    expectExpression("((x) -> x + 1)(2)", 3);
    expectExpression("{ let f = 1 -> 'one'; f(1) }", "one");

    const mismatch = interpret("let f = 1 -> 'one'; f(2);");
    expect(mismatch.evaluation).toMatchObject({ ok: false, diagnostic: { code: "SF4011" } });
  });

  it("treats a trailing brace as one ordinary braced argument", () => {
    expectExpression("{ fn apply(f) = f(2); apply { x -> x + 1 } }", 3);
    expectExpression("{ fn identity(x) = x; identity { 1 } }", 1);
    expectExpression("{ fn identity(x) = x; identity { 1; } }", null);

    const empty = expressionValue("{ fn identity(x) = x; identity {} }");
    expect(isDictionaryValue(empty) ? empty.entries : empty).toEqual([]);
  });

  it("supports repeated trailing brace calls", () => {
    expectExpression("{ fn curry(x) = y -> x + y; curry { 1 } { 2 } }", 3);
  });

  it("uses nil for if without else and associates else with the nearest if", () => {
    expectExpression("if (false) 1", null);
    expectExpression("if (true) if (false) 1 else 2", 2);
    expectExpression("if (false) if (true) 1 else 2 else 3", 3);
  });
});

describe("dictionary values", () => {
  it("expands identifier shorthand without changing the singleton block form", () => {
    expectExpression("{ let x = 1; let y = 2; {x, y} }", dictionaryValue([
      { key: "x", value: 1 },
      { key: "y", value: 2 },
    ]));
    expectExpression("{ let x = 1; {x,} }", dictionaryValue([{ key: "x", value: 1 }]));
    expectExpression("{ let x = 1; {x} }", 1);
  });

  it("mixes shorthand, explicit, and computed dictionary entries in source order", () => {
    const value = expressionValue([
      "{",
      "let name = 'Ada';",
      "let key = ['computed'];",
      "{name, active: true, [key]: 42}",
      "}",
    ].join(" "));

    expect(value).toEqual(dictionaryValue([
      { key: "name", value: "Ada" },
      { key: "active", value: true },
      { key: arrayValue(["computed"]), value: 42 },
    ]));
  });

  it("uses shorthand identifiers as dependencies, not their static keys", () => {
    const analysis = analyze("{external,};");

    expect(analysis.diagnostics).toEqual([]);
    expect([...analysis.resolution.dependencies]).toEqual(["external"]);
  });

  it("distinguishes shorthand dictionaries from block trailing arguments", () => {
    expectExpression(
      "{ let x = 7; fn identity(value) = value; identity {x,} }",
      dictionaryValue([{ key: "x", value: 7 }]),
    );
    expectExpression("{ let x = 7; fn identity(value) = value; identity {x} }", 7);
  });

  it("constructs static and arbitrary computed keys", () => {
    const value = expressionValue("{name: 'Ada', 1: 'one', [[1, 2]]: 'pair'}");
    expect(isDictionaryValue(value)).toBe(true);
    if (!isDictionaryValue(value)) {
      return;
    }
    expect(getDictionaryEntry(value, "name")).toBe("Ada");
    expect(getDictionaryEntry(value, 1)).toBe("one");
    expect(getDictionaryEntry(value, arrayValue([1, 2]))).toBe("pair");
  });

  it("makes field selection exact sugar for a text-key lookup", () => {
    expectExpression("{name: 'Ada'}.name", "Ada");
    expectExpression("{name: 'Ada'}['name']", "Ada");
  });

  it("uses deep recursive equality for array and dictionary keys", () => {
    expectExpression("{[[1, {x: 2}]]: 'found'}[[1, {x: 2}]]", "found");
    expectExpression("{{[{}]: 'empty'}[{}]}", "empty");
    expectExpression("{[{a: 1, b: 2}]: 'found'}[{b: 2, a: 1}]", "found");
  });

  it("replaces equal keys without moving the first entry", () => {
    const value = expressionValue("{[[1]]: 'first', other: 2, [[1]]: 'last'}");
    expect(isDictionaryValue(value)).toBe(true);
    if (!isDictionaryValue(value)) {
      return;
    }
    expect(value.entries).toHaveLength(2);
    expect(value.entries[0]?.value).toBe("last");
    expect(value.entries[1]?.key).toBe("other");
  });

  it("compares dictionaries deeply without considering insertion order", () => {
    expectExpression("{a: [1, 2], b: {x: 3}} == {b: {x: 3}, a: [1, 2]}", true);
    expectExpression("{a: 1} == {a: 2}", false);
  });

  it("compares function keys by closure identity", () => {
    expectExpression("{ let f = x -> x; {[f]: 1}[f] }", 1);
    expectExpression("{ let f = x -> x; {[f]: 1}[x -> x] }", null);
  });

  it("satisfies equality and lookup invariants for generated immutable data", () => {
    fc.assert(
      fc.property(runtimeData(3), runtimeData(3), (left, right) => {
        expect(runtimeEquals(left, left)).toBe(true);
        expect(runtimeEquals(left, right)).toBe(runtimeEquals(right, left));

        const equivalent = cloneRuntimeData(left);
        const third = cloneRuntimeData(equivalent);
        expect(runtimeEquals(left, equivalent)).toBe(true);
        expect(runtimeEquals(equivalent, third)).toBe(true);
        expect(runtimeEquals(left, third)).toBe(true);

        const dictionary = dictionaryValue([{ key: left, value: 42 }]);
        expect(getDictionaryEntry(dictionary, equivalent)).toBe(42);
      }),
      { numRuns: 300, seed: 0xd1c710 },
    );
  });
});

describe("evaluation contracts", () => {
  it("evaluates strict subexpressions from left to right", () => {
    const events: RuntimeValue[] = [];
    const tap = nativeFunction(({ arguments: [value = null] }) => {
      events.push(value);
      return value;
    }, { name: "tap", arity: 1 });

    interpret([
      "let first = tap('let');",
      "tap([tap('array-1'), tap('array-2')]);",
      "tap({[tap('key')]: tap('value')});",
      "tap(tap('argument'));",
    ].join(" "), { globals: { tap } });

    expect(events).toEqual([
      "let",
      "array-1", "array-2", arrayValue(["array-1", "array-2"]),
      "key", "value", dictionaryValue([{ key: "key", value: "value" }]),
      "argument", "argument",
    ]);
  });

  it("keeps static dependencies conservative under short-circuiting", () => {
    const result = interpret("condition and value;", {
      globals: { condition: false, value: true },
    });

    expect([...result.analysis.resolution.dependencies]).toEqual(["condition", "value"]);
    expect([...result.evaluation.usedDependencies]).toEqual(["condition"]);
  });

  it("never exposes a host exception as the language result", () => {
    const explode = nativeFunction(() => {
      throw new Error("host details");
    });
    const result = interpret("explode();", { globals: { explode } });

    expect(result.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4012", message: "Host function failed." },
    });
  });

  it("enforces step and call-depth limits", () => {
    const loop = "fn loop(n) = loop(n + 1); loop(0);";
    expect(interpret(loop, { maxCallDepth: 8 }).evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4025" },
    });
    expect(interpret("1 + 2;", { maxSteps: 1 }).evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4024" },
    });
  });
});

function expressionValue(
  expression: string,
  globals: Readonly<Record<string, RuntimeValue>> = {},
): RuntimeValue {
  let captured: RuntimeValue | undefined;
  const capture = nativeFunction(({ arguments: [value = null] }) => {
    captured = value;
    return null;
  }, { name: "capture", arity: 1 });
  const result = interpret(`capture(${expression});`, { globals: { ...globals, capture } });
  expect(result.analysis.diagnostics, expression).toEqual([]);
  expect(result.evaluation, expression).toMatchObject({ ok: true });
  if (captured === undefined) {
    throw new Error("Expression value was not captured.");
  }
  return captured;
}

function expectExpression(
  expression: string,
  expected: RuntimeValue,
  globals: Readonly<Record<string, RuntimeValue>> = {},
): void {
  expect(runtimeEquals(expressionValue(expression, globals), expected), expression).toBe(true);
}

function runtimeData(depth: number): fc.Arbitrary<RuntimeValue> {
  const primitive = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -100, max: 100 }),
    fc.string({ maxLength: 8 }),
  );
  if (depth === 0) {
    return primitive;
  }
  return fc.oneof(
    primitive,
    fc.array(runtimeData(depth - 1), { maxLength: 4 }).map(arrayValue),
    fc.array(
      fc.tuple(runtimeData(depth - 1), runtimeData(depth - 1)),
      { maxLength: 4 },
    ).map((entries) => dictionaryValue(entries.map(([key, value]) => ({ key, value })))),
  );
}

function cloneRuntimeData(value: RuntimeValue): RuntimeValue {
  if (isArrayValue(value)) {
    return arrayValue(value.elements.map(cloneRuntimeData));
  }
  if (isDictionaryValue(value)) {
    return dictionaryValue(value.entries.map((entry) => ({
      key: cloneRuntimeData(entry.key),
      value: cloneRuntimeData(entry.value),
    })));
  }
  if (isFunctionValue(value)) {
    return value;
  }
  return value;
}
