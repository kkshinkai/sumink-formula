import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { analyze, interpret } from "./interpreter.js";
import {
  arrayValue,
  isArrayValue,
  nativeFunction,
  objectValue,
  type RuntimeValue,
} from "./runtime-value.js";

describe("lexical closures", () => {
  it("uses lexical rather than dynamic scope under shadowing", () => {
    expectValue("let x = 1; f = () -> x in let x = 2 in f()", 1);
  });

  it("keeps captured environments alive after the creating call returns", () => {
    expectValue("let make = (x) -> () -> x in let f = make(41) in f() + 1", 42);
  });

  it("keeps a closure valid after it escapes to the host and enters another evaluation", () => {
    const created = successfulValue("() -> source", { source: 41 });
    const reused = interpret("closure()", { globals: { closure: created, source: 99 } });

    expect(reused.analysis.diagnostics).toEqual([]);
    expect(reused.evaluation).toMatchObject({ ok: true, value: 41 });
    expect([...reused.analysis.resolution.dependencies]).toEqual(["closure"]);
    expect([...reused.evaluation.usedDependencies]).toEqual(["closure"]);
  });

  it("keeps an escaped mutually-recursive let frame intact", () => {
    const even = successfulValue([
      "let even = (n) -> if n == 0 then true else odd(n - 1);",
      "odd = (n) -> if n == 0 then false else even(n - 1)",
      "in even",
    ].join(" "));

    expectValue("even(25)", false, { even });
    expectValue("even(26)", true, { even });
  });

  it("restores current dependency tracking inside callbacks invoked by an escaped closure", () => {
    const apply = successfulValue("(callback) -> callback()");
    const result = interpret("apply(() -> source)", {
      globals: { apply, source: 42 },
    });

    expect(result.evaluation).toMatchObject({ ok: true, value: 42 });
    expect([...result.analysis.resolution.dependencies]).toEqual(["apply", "source"]);
    expect([...result.evaluation.usedDependencies]).toEqual(["apply", "source"]);
  });

  it("creates a separate captured parameter frame for every invocation", () => {
    const value = successfulValue(
      "let make = (x) -> () -> x; a = make(1); b = make(2) in [a(), b()]",
    );

    expect(isArrayValue(value) ? value.elements : value).toEqual([1, 2]);
  });

  it("supports self recursion through the let group's recursive frame", () => {
    expectValue(
      "let factorial = (n) -> if n == 0 then 1 else n * factorial(n - 1) in factorial(7)",
      5_040,
    );
  });

  it("supports order-independent mutual recursion between closures in one let group", () => {
    const evenFirst = [
      "let even = (n) -> if n == 0 then true else odd(n - 1);",
      "odd = (n) -> if n == 0 then false else even(n - 1)",
      "in even(30)",
    ].join(" ");
    const oddFirst = [
      "let odd = (n) -> if n == 0 then false else even(n - 1);",
      "even = (n) -> if n == 0 then true else odd(n - 1)",
      "in even(30)",
    ].join(" ");

    expectValue(evenFirst, true);
    expectValue(oddFirst, true);
  });

  it("supports a three-function recursion cycle", () => {
    expectValue(
      [
        "let a = (n) -> if n == 0 then 'a' else b(n - 1);",
        "b = (n) -> if n == 0 then 'b' else c(n - 1);",
        "c = (n) -> if n == 0 then 'c' else a(n - 1)",
        "in a(5)",
      ].join(" "),
      "c",
    );
  });

  it("reports an early read of an uninitialized recursive slot", () => {
    const result = interpret("let value = next(); next = () -> 1 in value");

    expect(result.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4005", phase: "evaluate" },
    });
  });

  it("does not leak a let binding into the next top-level expression", () => {
    const analysis = analyze("let f = () -> 1 in f(); f");

    expect([...analysis.resolution.dependencies]).toEqual(["f"]);
  });

  it("preserves closure capture and mutual recursion across generated values", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 10_000 }),
        fc.integer({ min: 0, max: 100 }),
        (captured, depth) => {
          expectValue(`let make = (x) -> () -> x in make(${captured})()`, captured);
          expectValue(
            [
              "let even = (n) -> if n == 0 then true else odd(n - 1);",
              "odd = (n) -> if n == 0 then false else even(n - 1)",
              `in even(${depth})`,
            ].join(" "),
            depth % 2 === 0,
          );
        },
      ),
      { numRuns: 200, seed: 0x1e71ca1 },
    );
  });
});

describe("binding resolution and dependencies", () => {
  it("assigns distinct identities to shadowed bindings", () => {
    const analysis = analyze("let x = source; captured = () -> x in let x = other in captured() + x");
    const localReferences = [...analysis.resolution.references.values()]
      .filter((reference) => reference.kind === "local")
      .map((reference) => reference.bindingId);

    expect(analysis.diagnostics).toEqual([]);
    // outer x, captured, and inner x are three independent lexical identities.
    expect(new Set(localReferences).size).toBe(3);
    expect([...analysis.resolution.dependencies]).toEqual(["source", "other"]);
  });

  it("keeps dependencies invariant under alpha-renaming", () => {
    const first = analyze("let x = input in (y) -> x + y + outside");
    const renamed = analyze("let local = input in (argument) -> local + argument + outside");

    expect([...first.resolution.dependencies]).toEqual([...renamed.resolution.dependencies]);
  });

  it("never observes a dependency omitted by static resolution", () => {
    fc.assert(
      fc.property(fc.boolean(), (condition) => {
        const source = "condition and value";
        const result = interpret(source, { globals: { condition, value: true } });
        const predicted = result.analysis.resolution.dependencies;

        for (const actual of result.evaluation.usedDependencies) {
          expect(predicted.has(actual)).toBe(true);
        }
        expect([...predicted]).toEqual(["condition", "value"]);
        expect([...result.evaluation.usedDependencies]).toEqual(
          condition ? ["condition", "value"] : ["condition"],
        );
      }),
      { numRuns: 100, seed: 0xd3e3d },
    );
  });

  it("accepts the full ReadonlyMap host contract rather than only Map instances", () => {
    const globals = new ReadonlyGlobals([["answer", 42]]);

    expect(interpret("answer", { globals }).evaluation).toMatchObject({ ok: true, value: 42 });
  });

  it("diagnoses duplicate binders in one lexical scope", () => {
    const analysis = analyze("let x = 1; x = 2 in x");

    expect(analysis.resolution.diagnostics).toHaveLength(1);
    expect(analysis.resolution.diagnostics[0]).toMatchObject({ code: "SF3000", phase: "resolve" });
    expect(analysis.resolution.diagnostics[0]?.relatedInformation).toHaveLength(1);
  });
});

describe("first-version expressions", () => {
  it("agrees with an independent arithmetic model for generated trees", () => {
    fc.assert(
      fc.property(arithmeticExpression(5), ({ source, value }) => {
        expectValue(source, value);
      }),
      { numRuns: 500, seed: 0xa117e },
    );
  });

  it("evaluates program and block sequences to their final value", () => {
    expectValue("1; 2; 3;", 3);
    expectValue("do {}", null);
    expectValue("do {1; 2; 3;}", 3);
  });

  it("evaluates strict subexpressions in documented left-to-right order", () => {
    const events: RuntimeValue[] = [];
    const tap = nativeFunction(({ arguments: [value = null] }) => {
      events.push(value);
      return value;
    }, { name: "tap", arity: 1 });

    expectValue(
      "let a = tap('let-a'); b = tap('let-b') in "
      + "[tap('array-a'), {[tap('key')]: tap('value')}, tap('array-b')]",
      arrayValue([
        "array-a",
        objectValue([{ key: "key", value: "value" }]),
        "array-b",
      ]),
      { tap },
    );
    expect(events).toEqual(["let-a", "let-b", "array-a", "key", "value", "array-b"]);
  });

  it("evaluates grouped, prefix, conditional, and match-test expressions", () => {
    expectValue("-(1 + 2) * 3", -9);
    expectValue("not false", true);
    expectValue("if false then missing elif true then 2 else missing", 2);
    expectValue("1 match 1", true);
    expectValue("1 match 2", false);
    expectValue("1 match value", true);
  });

  it("defines strict, non-coercing operator behavior", () => {
    expectValue("10 - 3 - 2", 5);
    expectValue("false or true and false", false);
    expectValue("'a' + 'b'", "ab");
    expectValue("'1' == 1", false);
    expectValue("-0 == 0", true);
    expectValue("[1, {x: 2}] == [1, {x: 2}]", true);
    expectValue("{a: 1, b: 2} == {b: 2, a: 1}", true);

    expect(interpret("1 < '2'").evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4015" },
    });
    expect(interpret("1 / 0").evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4013" },
    });
  });

  it("compares deeply nested host values without consuming the host call stack", () => {
    let left: RuntimeValue = null;
    let right: RuntimeValue = null;
    for (let depth = 0; depth < 10_000; depth += 1) {
      left = arrayValue([left]);
      right = arrayValue([right]);
    }

    expectValue("left == right", true, { left, right });
  });

  it("evaluates computed object keys and chained selectors", () => {
    expectValue("{['na' + 'me']: {scores: [10, 20, 30]}}.name.scores[1]", 20);
    expectValue("{[2]: 'two'}[2]", "two");
    expectValue("{value: 1, value: 2}.value", 2);
    expectValue("{}.missing", null);
    expectValue("[{run: () -> 7}][0].run()", 7);
  });

  it("rejects negative array indexes and non-finite arithmetic", () => {
    expect(interpret("[1][-1]").evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4016" },
    });
    expect(interpret("1e308 * 1e308").evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4023" },
    });
  });

  it("binds match case identifiers only within their result", () => {
    expectValue("42 match { case 0 -> 'zero' case value -> value + 1 }", 43);
  });

  it("uses literal closure parameters as real patterns", () => {
    expectValue("let onlyOne = (1) -> 'one' in onlyOne(1)", "one");

    const mismatch = interpret("let onlyOne = (1) -> 'one' in onlyOne(2)");
    expect(mismatch.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4011", phase: "evaluate" },
    });
  });

  it("desugars an infix call to an ordinary lexical function call", () => {
    const pair = nativeFunction(
      ({ arguments: arguments_ }) => arrayValue(arguments_),
      { name: "pair", arity: 2 },
    );
    const value = successfulValue("1 pair 2", { pair });

    expect(isArrayValue(value) ? value.elements : value).toEqual([1, 2]);
  });

  it("applies documented precedence and associativity to named infix calls", () => {
    const pair = nativeFunction(
      ({ arguments: arguments_ }) => arrayValue(arguments_),
      { name: "pair", arity: 2 },
    );
    const value = successfulValue("1 + 2 pair 3 * 4", { pair });
    const leftAssociated = successfulValue("1 pair 2 pair 3", { pair });

    expect(isArrayValue(value) ? value.elements : value).toEqual([3, 12]);
    expect(isArrayValue(leftAssociated) ? leftAssociated.elements : leftAssociated).toEqual([
      { kind: "array", elements: [1, 2] },
      3,
    ]);
  });

  it("short-circuits boolean operators", () => {
    expectValue("false and missing", false);
    expectValue("true or missing", true);
  });

  it("never exposes a host exception as the language result", () => {
    const explode = nativeFunction(() => {
      throw new Error("host details");
    });
    const result = interpret("explode()", { globals: { explode } });

    expect(result.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4012", message: "Host function failed." },
    });
  });

  it("rejects invalid values at both host boundaries", () => {
    const invalidGlobal = interpret("bad", {
      globals: { bad: Number.NaN as RuntimeValue },
    });
    const invalidResult = nativeFunction(
      () => ({ kind: "array", elements: [] }) as RuntimeValue,
    );
    const returned = interpret("invalidResult()", { globals: { invalidResult } });

    expect(invalidGlobal.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4026" },
    });
    expect(returned.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4027" },
    });
  });

  it("attaches formula call sites to evaluation failures", () => {
    const result = interpret("let fail = () -> 1 / 0; call = () -> fail() in call()");

    expect(result.evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4013" },
    });
    if (!result.evaluation.ok) {
      expect(result.evaluation.diagnostic.relatedInformation).toHaveLength(2);
      expect(result.evaluation.diagnostic.relatedInformation?.every(
        (entry) => entry.message === "Called from here.",
      )).toBe(true);
    }
  });

  it("reports deterministic resource-limit diagnostics", () => {
    const loop = "let loop = (n) -> loop(n + 1) in loop(0)";

    expect(interpret(loop, { maxCallDepth: 20 }).evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4025" },
    });
    expect(interpret("1 + 2", { maxSteps: 2 }).evaluation).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4024" },
    });
  });
});

function expectValue(
  source: string,
  expected: RuntimeValue,
  globals?: Readonly<Record<string, RuntimeValue>>,
): void {
  expect(successfulValue(source, globals)).toEqual(expected);
}

function successfulValue(
  source: string,
  globals?: Readonly<Record<string, RuntimeValue>>,
): RuntimeValue {
  const result = interpret(source, globals === undefined ? {} : { globals });
  expect(result.analysis.diagnostics, source).toEqual([]);
  expect(result.evaluation, source).toMatchObject({ ok: true });
  if (!result.evaluation.ok) {
    throw new Error(result.evaluation.diagnostic.message);
  }
  return result.evaluation.value;
}

interface ArithmeticExample {
  readonly source: string;
  readonly value: number;
}

class ReadonlyGlobals implements ReadonlyMap<string, RuntimeValue> {
  readonly #values: Map<string, RuntimeValue>;

  public constructor(entries: Iterable<readonly [string, RuntimeValue]>) {
    this.#values = new Map(entries);
  }

  public get size(): number {
    return this.#values.size;
  }

  public get(key: string): RuntimeValue | undefined {
    return this.#values.get(key);
  }

  public has(key: string): boolean {
    return this.#values.has(key);
  }

  public entries(): MapIterator<[string, RuntimeValue]> {
    return this.#values.entries();
  }

  public keys(): MapIterator<string> {
    return this.#values.keys();
  }

  public values(): MapIterator<RuntimeValue> {
    return this.#values.values();
  }

  public forEach(
    callback: (value: RuntimeValue, key: string, map: ReadonlyMap<string, RuntimeValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callback.call(thisArg, value, key, this);
    }
  }

  public [Symbol.iterator](): MapIterator<[string, RuntimeValue]> {
    return this.#values[Symbol.iterator]();
  }
}

function arithmeticExpression(depth: number): fc.Arbitrary<ArithmeticExample> {
  const leaf = fc.integer({ min: -20, max: 20 }).map((value) => ({
    source: value < 0 ? `(${value})` : String(value),
    value,
  }));
  if (depth === 0) {
    return leaf;
  }

  return fc.oneof(
    { depthSize: "small" },
    leaf,
    fc.tuple(
      arithmeticExpression(depth - 1),
      fc.constantFrom("+", "-", "*"),
      arithmeticExpression(depth - 1),
    ).map(([left, operator, right]) => ({
      source: `(${left.source} ${operator} ${right.source})`,
      value: operator === "+"
        ? left.value + right.value
        : operator === "-"
          ? left.value - right.value
          : left.value * right.value,
    })),
  );
}
