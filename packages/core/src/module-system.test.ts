import { describe, expect, it, vi } from "vitest";

import {
  constantValue,
  defineEnvironment,
  externalValue,
  hostFunction,
  nativeModule,
} from "./environment.js";
import type { FileModuleLoader, SourceUnit } from "./module-system.js";
import type { RuntimeValue } from "./runtime-value.js";

describe("formula modules", () => {
  it("links forward nested modules and imports exported declarations", () => {
    const values: RuntimeValue[] = [];
    const environment = defineEnvironment({
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          values.push(value);
          return null;
        },
      }),
    });
    const compilation = environment.compileProgram(`
      import geometry.{area as calculate, unit};
      capture(calculate(3, 4));
      capture(unit);

      module geometry {
        export let unit = "px";
        export fn area(width, height) = width * height;
      }
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    expect(compilation.program.evaluate(environment.createActivation({}))).toMatchObject({
      ok: true,
      value: null,
    });
    expect(values).toEqual([12, "px"]);
  });

  it("keeps nested modules lexically isolated from the enclosing program", () => {
    const environment = defineEnvironment({ outer: constantValue(1) });
    const compilation = environment.compileProgram(`
      module isolated { export fn read() = outer; }
      import isolated.{read};
      read();
    `);

    expect(compilation).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "SF3001",
        message: "Cannot find binding 'outer' in the host environment.",
      })],
    });
  });

  it("links nested native modules and keeps canonical dependency names", () => {
    const environment = defineEnvironment({
      app: nativeModule({
        selection: externalValue(),
        math: nativeModule({ pi: constantValue(Math.PI) }),
      }),
    });
    const compilation = environment.compileProgram(`
      import app.{selection as current};
      import app.math.{pi};
      current + pi;
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    expect(compilation.program.dependencies).toEqual(["app.selection"]);
    const result = compilation.program.evaluate(environment.createActivation({
      app: { selection: 2 },
    }));
    expect(result).toMatchObject({ ok: true, value: null });
    expect([...result.usedDependencies]).toEqual(["app.selection"]);
  });

  it("loads each canonical file module once and preserves exported closure identity", () => {
    const values: RuntimeValue[] = [];
    const loaded = vi.fn((specifier: string, _referrer: SourceUnit) => {
      if (specifier !== "./library.sumi") {
        return { ok: false as const, message: "not found" };
      }
      return {
        ok: true as const,
        source: {
          name: "/canonical/library.sumi",
          text: "export fn identity(value) = value;",
        },
      };
    });
    const environment = defineEnvironment({
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          values.push(value);
          return null;
        },
      }),
    });
    const compilation = environment.compileProgram(`
      import {identity as first} from "./library.sumi";
      import library from "./library.sumi";
      capture(first == library.identity);
    `, {
      sourceName: "/canonical/main.sumi",
      fileModuleLoader: { load: loaded },
    });

    expect(compilation).toMatchObject({ ok: true });
    expect(loaded).toHaveBeenCalledTimes(1);
    if (!compilation.ok) return;
    expect(compilation.program.analysis.sources.has("/canonical/library.sumi")).toBe(true);
    expect(compilation.program.evaluate(environment.createActivation({}))).toMatchObject({
      ok: true,
      value: null,
    });
    expect(values).toEqual([true]);
  });

  it("reports project imports and file-module cycles as link diagnostics", () => {
    const environment = defineEnvironment({});
    const project = environment.compileProgram("import missing.{value};");
    expect(project).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "SF3100",
        message: "Project module imports are not available.",
      })],
    });

    const loader: FileModuleLoader = {
      load(specifier) {
        return specifier === "./a.sumi"
          ? {
              ok: true,
              source: {
                name: "/a.sumi",
                text: "import {b} from \"./b.sumi\"; export let a = b;",
              },
            }
          : {
              ok: true,
              source: {
                name: "/b.sumi",
                text: "import {a} from \"./a.sumi\"; export let b = a;",
              },
            };
      },
    };
    const cycle = environment.compileProgram(
      "import {a} from \"./a.sumi\"; a;",
      { sourceName: "/main.sumi", fileModuleLoader: loader },
    );
    expect(cycle).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "SF3102" })],
    });

    const nestedCycle = environment.compileProgram(`
      module first {
        import second.{value as secondValue};
        export let value = secondValue;
      }
      module second {
        import first.{value as firstValue};
        export let value = firstValue;
      }
    `);
    expect(nestedCycle).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "SF3102" }),
      ]),
    });
  });

  it("resolves direct qualification, nested re-exports, and module aliases", () => {
    const values: RuntimeValue[] = [];
    const environment = defineEnvironment({
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          values.push(value);
          return null;
        },
      }),
    });
    const compilation = environment.compileProgram(`
      module base {
        export fn double(value) = value * 2;
      }
      module facade {
        export base.{double as twice};
      }
      import facade as api;
      capture(base.double(10));
      capture(api.twice(21));
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    expect(compilation.program.evaluate(environment.createActivation({}))).toMatchObject({
      ok: true,
    });
    expect(values).toEqual([20, 42]);
  });

  it("applies local, explicit, and wildcard import precedence", () => {
    const values: RuntimeValue[] = [];
    const environment = defineEnvironment({
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          values.push(value);
          return null;
        },
      }),
    });
    const compilation = environment.compileProgram(`
      module first { export let value = 1; export let firstOnly = 10; }
      module second { export let value = 2; export let secondOnly = 20; }
      import first.{value, firstOnly};
      import second.{value as _, *};
      let value = 3;
      capture(value);
      capture(firstOnly);
      capture(secondOnly);
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    compilation.program.evaluate(environment.createActivation({}));
    expect(values).toEqual([3, 10, 20]);

    const ambiguous = environment.compileProgram(`
      module first { export let value = 1; }
      module second { export let value = 2; }
      import first.{*};
      import second.{*};
    `);
    expect(ambiguous).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: "SF3105",
        message: "Import 'value' is ambiguous.",
      })],
    });

    const moduleValues: RuntimeValue[] = [];
    const moduleEnvironment = defineEnvironment({
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          moduleValues.push(value);
          return null;
        },
      }),
    });
    const modulePrecedence = moduleEnvironment.compileProgram(`
      module selected { export let value = 1; }
      module other { export let value = 2; }
      import other as selected;
      import selected.{value};
      capture(value);
    `);
    expect(modulePrecedence).toMatchObject({ ok: true });
    if (!modulePrecedence.ok) return;
    modulePrecedence.program.evaluate(moduleEnvironment.createActivation({}));
    expect(moduleValues).toEqual([1]);
  });

  it("initializes a module once per evaluation and again for a new activation", () => {
    let calls = 0;
    const values: RuntimeValue[] = [];
    const environment = defineEnvironment({
      host: nativeModule({
        next: hostFunction({
          parameters: [],
          invoke: () => {
            calls += 1;
            return calls;
          },
        }),
      }),
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          values.push(value);
          return null;
        },
      }),
    });
    const compilation = environment.compileProgram(`
      module state {
        import host.{next};
        export let value = next();
      }
      import state.{value as first};
      import state.{value as second};
      capture(first);
      capture(second);
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    compilation.program.evaluate(environment.createActivation({}));
    compilation.program.evaluate(environment.createActivation({}));
    expect(calls).toBe(2);
    expect(values).toEqual([1, 1, 2, 2]);
  });

  it("preserves module mutual recursion, escaping closures, and strict let order", () => {
    const values: RuntimeValue[] = [];
    const environment = defineEnvironment({
      capture: hostFunction({
        parameters: ["value"],
        invoke: ({ arguments: [value = null] }) => {
          values.push(value);
          return null;
        },
      }),
    });
    const compilation = environment.compileProgram(`
      module algorithms {
        export fn even(n) = if (n == 0) true else odd(n - 1);
        export fn odd(n) = if (n == 0) false else even(n - 1);
        export fn makeAdder(offset) = value -> value + offset;
      }
      import algorithms.{even, makeAdder};
      let addTen = makeAdder(10);
      capture(even(20));
      capture(addTen(32));
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    expect(compilation.program.evaluate(environment.createActivation({}))).toMatchObject({
      ok: true,
    });
    expect(values).toEqual([true, 42]);

    const uninitialized = environment.compileProgram(`
      module invalid {
        export let eager = read();
        let later = 1;
        fn read() = later;
      }
      import invalid.{eager};
      eager;
    `);
    expect(uninitialized).toMatchObject({ ok: true });
    if (!uninitialized.ok) return;
    expect(uninitialized.program.evaluate(environment.createActivation({}))).toMatchObject({
      ok: false,
      diagnostic: { code: "SF4005" },
    });
  });

  it("tracks static and actual Native Module dependencies independently", () => {
    const environment = defineEnvironment({
      app: nativeModule({ selection: externalValue() }),
    });
    const compilation = environment.compileProgram(`
      module reader {
        import app.{selection};
        export fn read(enabled) = if (enabled) selection else 0;
      }
      import reader.{read};
      read(false);
    `);

    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) return;
    expect(compilation.program.dependencies).toEqual(["app.selection"]);
    const skipped = compilation.program.evaluate(environment.createActivation({}));
    expect(skipped).toMatchObject({ ok: true });
    expect([...skipped.usedDependencies]).toEqual([]);
  });

  it("rejects malformed selectors, missing exports, and non-module qualifiers", () => {
    const environment = defineEnvironment({});
    const cases = [
      ["module m {} import m.{};", "SF2004", "at least one import selector"],
      ["module m {} import m.{*, *};", "SF3105", "at most one wildcard"],
      ["module m {} import m.{*, missing as _};", "SF3105", "must be last"],
      ["module m {} import m.{missing};", "SF3103", "no export named 'missing'"],
      ["let value = 1; import value.{member};", "SF3104", "is a value, not a module"],
      ["module m {} let value = m;", "SF3001", "cannot be used as a runtime value"],
      ["module m {} fn m() = null;", "SF3106", "Duplicate declaration 'm'"],
      ["module m { export let _ = 1; }", "SF3106", "must bind an identifier"],
    ] as const;

    for (const [source, code, message] of cases) {
      const compilation = environment.compileProgram(source);
      expect(compilation, source).toMatchObject({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code, message: expect.stringContaining(message) }),
        ]),
      });
    }
  });

  it("detects inconsistent source text returned for one canonical name", () => {
    const environment = defineEnvironment({});
    const compilation = environment.compileProgram(`
      import {first} from "./first.sumi";
      import {second} from "./second.sumi";
    `, {
      sourceName: "/main.sumi",
      fileModuleLoader: {
        load(specifier) {
          return {
            ok: true,
            source: {
              name: "/same.sumi",
              text: specifier === "./first.sumi"
                ? "export let first = 1;"
                : "export let second = 2;",
            },
          };
        },
      },
    });

    expect(compilation).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "SF3107" })],
    });
  });

  it("rejects missing and conflicting re-exports", () => {
    const environment = defineEnvironment({});
    const compilation = environment.compileProgram(`
      module first { export let value = 1; }
      module second { export let value = 2; }
      module facade {
        export first.{*};
        export second.{*};
        export first.{missing};
      }
    `);

    expect(compilation).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "SF3103" }),
        expect.objectContaining({
          code: "SF3106",
          message: "Export 'value' is provided by multiple modules.",
        }),
      ]),
    });
  });

  it("turns absent, failed, and throwing loaders into load diagnostics", () => {
    const environment = defineEnvironment({});
    const source = "import {value} from './missing.sumi';";
    const absent = environment.compileProgram(source, { sourceName: "/main.sumi" });
    const failed = environment.compileProgram(source, {
      sourceName: "/main.sumi",
      fileModuleLoader: { load: () => ({ ok: false, message: "not found" }) },
    });
    const throwing = environment.compileProgram(source, {
      sourceName: "/main.sumi",
      fileModuleLoader: {
        load: () => {
          throw new Error("unavailable");
        },
      },
    });

    for (const compilation of [absent, failed, throwing]) {
      expect(compilation).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: "SF3101",
          phase: "load",
          sourceName: "/main.sumi",
        })],
      });
    }

    const load = vi.fn(() => ({ ok: false as const, message: "must not run" }));
    const invalid = environment.compileProgram(
      "import {} from './missing.sumi';",
      { fileModuleLoader: { load } },
    );
    expect(invalid).toMatchObject({ ok: false });
    expect(load).not.toHaveBeenCalled();
  });

  it("does not link or recursively load a File Module with syntax errors", () => {
    const environment = defineEnvironment({});
    const load = vi.fn((specifier: string) => specifier === "./broken.sumi"
      ? {
          ok: true as const,
          source: {
            name: "/broken.sumi",
            text: "export let value = ; import {nested} from './nested.sumi';",
          },
        }
      : { ok: false as const, message: "nested load must not run" });
    const compilation = environment.compileProgram(
      "import {value} from './broken.sumi';",
      {
        sourceName: "/main.sumi",
        fileModuleLoader: { load },
      },
    );

    expect(compilation).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({
        phase: "parse",
        sourceName: "/broken.sumi",
      })],
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
