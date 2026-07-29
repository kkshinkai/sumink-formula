import { describe, expect, it, vi } from "vitest";

import {
  constantValue,
  defineEnvironment,
  externalValue,
  hostFunction,
  nativeModule,
} from "./environment.js";
import {
  dictionaryValue,
  getDictionaryEntry,
  isArrayValue,
  isDictionaryValue,
  runtimeValueFromJson,
  type JsonValue,
  type RuntimeValue,
} from "./runtime-value.js";

describe("host environments", () => {
  it("compiles and repeatedly evaluates an expression in a plain outer scope", () => {
    const environment = defineEnvironment({
      shape: externalValue(),
      zoom: externalValue(),
      pi: constantValue(Math.PI),
    });
    const compilation = environment.compileExpression("shape.width * zoom + pi");

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) {
      return;
    }
    expect(compilation.program.freeNames).toEqual(["shape", "zoom", "pi"]);
    expect(compilation.program.dependencies).toEqual(["shape", "zoom"]);

    const first = compilation.program.evaluate(environment.createActivation({
      shape: runtimeValueFromJson({ width: 10 }),
      zoom: 2,
    }));
    const second = compilation.program.evaluate(environment.createActivation({
      shape: runtimeValueFromJson({ width: 4 }),
      zoom: 3,
    }));

    expect(first).toMatchObject({ ok: true, value: 20 + Math.PI });
    expect(second).toMatchObject({ ok: true, value: 12 + Math.PI });
    expect([...first.usedDependencies]).toEqual(["shape", "zoom"]);
  });

  it("uses ordinary lexical shadowing rather than a separate namespace mechanism", () => {
    const environment = defineEnvironment({
      shape: externalValue(),
      zoom: externalValue(),
    });
    const compilation = environment.compileExpression(
      "{ let zoom = 2; shape.width * zoom }",
    );

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) {
      return;
    }
    expect(compilation.program.freeNames).toEqual(["shape"]);
    expect(compilation.program.dependencies).toEqual(["shape"]);
    const result = compilation.program.evaluate(environment.createActivation({
      shape: runtimeValueFromJson({ width: 21 }),
    }));
    expect(result).toMatchObject({ ok: true, value: 42 });
  });

  it("reports names absent from the host environment during compilation", () => {
    const environment = defineEnvironment({ value: externalValue() });
    const compilation = environment.compileExpression("value + missing");

    expect(compilation).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "SF3001",
        phase: "resolve",
        message: "Cannot find binding 'missing' in the host environment.",
      })],
    });
  });

  it("keeps host functions first-class while excluding them from reactive dependencies", () => {
    const events: RuntimeValue[] = [];
    const environment = defineEnvironment({
      value: externalValue(),
      tap: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          events.push(value);
          return value;
        },
      }),
    });
    const compilation = environment.compileProgram("tap(value);");

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) {
      return;
    }
    expect(compilation.program.freeNames).toEqual(["tap", "value"]);
    expect(compilation.program.dependencies).toEqual(["value"]);

    const result = compilation.program.evaluate(environment.createActivation({ value: 42 }));
    expect(result).toMatchObject({ ok: true, value: null });
    expect([...result.usedDependencies]).toEqual(["value"]);
    expect(events).toEqual([42]);
  });

  it("preserves the distinction between expression and program roots", () => {
    const environment = defineEnvironment({});
    const expression = environment.compileExpression("1 + 2");
    const program = environment.compileProgram("1 + 2;");
    const expressionWithTerminator = environment.compileExpression("1 + 2;");
    const activation = environment.createActivation({});

    expect(expression.ok && expression.program.evaluate(activation)).toMatchObject({
      ok: true,
      value: 3,
    });
    expect(program.ok && program.program.evaluate(activation)).toMatchObject({
      ok: true,
      value: null,
    });
    expect(expressionWithTerminator).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "SF2004",
        message: "Expected the end of the expression.",
      })],
    });
  });

  it("rejects missing inputs only if evaluation reaches the binding", () => {
    const environment = defineEnvironment({
      condition: externalValue(),
      value: externalValue(),
    });
    const compilation = environment.compileExpression("condition and value");
    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) {
      return;
    }

    const skipped = compilation.program.evaluate(environment.createActivation({ condition: false }));
    const required = compilation.program.evaluate(environment.createActivation({ condition: true }));
    expect(skipped).toMatchObject({ ok: true, value: false });
    expect([...skipped.usedDependencies]).toEqual(["condition"]);
    expect(required).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4003" },
    });
    expect([...required.usedDependencies]).toEqual(["condition", "value"]);
  });

  it("prevents activations from crossing environment boundaries", () => {
    const firstEnvironment = defineEnvironment({ value: externalValue() });
    const secondEnvironment = defineEnvironment({ value: externalValue() });
    const compilation = firstEnvironment.compileExpression("value");
    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) {
      return;
    }

    const wrongActivation = secondEnvironment.createActivation({ value: 1 });
    expect(() => compilation.program.evaluate(wrongActivation as never)).toThrow(
      "The activation belongs to a different Sumi environment.",
    );
  });

  it("validates environment definitions, function signatures, and activations", () => {
    expect(() => defineEnvironment({ if: externalValue() })).toThrow(
      "Environment binding 'if' is not a Sumi identifier.",
    );
    expect(() => hostFunction({ parameters: ["if"], invoke: () => null })).toThrow(
      "Host function parameter 'if' is not a Sumi identifier.",
    );
    expect(() => hostFunction({ parameters: ["value", "value"], invoke: () => null })).toThrow(
      "Host function parameter 'value' is duplicated.",
    );

    const environment = defineEnvironment({
      input: externalValue(),
      fixed: constantValue(1),
    });
    expect(() => environment.createActivation({ fixed: 2 } as never)).toThrow(
      "Activation cannot replace constant binding 'fixed'.",
    );
    expect(() => environment.createActivation({ other: 2 } as never)).toThrow(
      "Activation value 'other' is not declared by this environment.",
    );
  });

  it("validates recursive Native Module definitions and activation values", () => {
    const environment = defineEnvironment({
      app: nativeModule({
        selection: externalValue(),
        math: nativeModule({ pi: constantValue(Math.PI) }),
      }),
    });

    expect(() => environment.createActivation({
      app: { selection: [1, 2] as never },
    })).toThrow(
      "Activation value 'app.selection' is not an immutable Sumi runtime value.",
    );
    expect(() => environment.createActivation({
      app: { math: { pi: 3 } } as never,
    })).toThrow("Activation cannot replace constant binding 'app.math.pi'.");
    expect(() => environment.createActivation({
      app: { missing: 1 } as never,
    })).toThrow("Activation value 'app.missing' is not declared by this environment.");
    expect(() => nativeModule({ if: externalValue() } as never)).toThrow(
      "Native module member 'if' is not a Sumi identifier.",
    );
  });
});

describe("runtimeValueFromJson", () => {
  it("copies nested JSON data into immutable arrays and dictionaries", () => {
    const source = {
      name: "Ada",
      scores: [1, 2],
      address: { city: "London" },
    };
    const value = runtimeValueFromJson(source);

    source.name = "Changed";
    source.scores[0] = 99;

    expect(isDictionaryValue(value)).toBe(true);
    if (!isDictionaryValue(value)) {
      return;
    }
    expect(getDictionaryEntry(value, "name")).toBe("Ada");
    const scores = getDictionaryEntry(value, "scores");
    expect(scores !== undefined && isArrayValue(scores) && scores.elements).toEqual([1, 2]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.entries)).toBe(true);
  });

  it("preserves JSON object property order as dictionary insertion order", () => {
    const value = runtimeValueFromJson({ first: 1, second: 2 });
    expect(value).toEqual(dictionaryValue([
      { key: "first", value: 1 },
      { key: "second", value: 2 },
    ]));
  });

  it("rejects non-JSON structures without executing accessors", () => {
    const getter = vi.fn(() => 1);
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: getter,
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => runtimeValueFromJson(accessor as JsonValue)).toThrow(
      "JSON property 'value' must be an enumerable data property.",
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() => runtimeValueFromJson(cyclic as JsonValue)).toThrow(
      "JSON values cannot contain cycles.",
    );
    expect(() => runtimeValueFromJson([, 1] as JsonValue)).toThrow(
      "JSON arrays cannot contain holes.",
    );
    expect(() => runtimeValueFromJson(Number.NaN as JsonValue)).toThrow(
      "A JSON number must be finite.",
    );
  });
});
