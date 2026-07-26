import { describe, expect, it } from "vitest";

import {
  arrayValue,
  dictionaryValue,
  getDictionaryEntry,
  isRuntimeValue,
  nativeFunction,
  runtimeEquals,
  type RuntimeValue,
} from "./runtime-value.js";

describe("runtime value boundary", () => {
  it("accepts values created by the public factories", () => {
    const value = dictionaryValue([
      { key: arrayValue(["items"]), value: arrayValue([null, true, 1, "text"]) },
      { key: "run", value: nativeFunction(() => null) },
    ]);

    expect(isRuntimeValue(value)).toBe(true);
  });

  it("preserves the first equal key and replaces its value", () => {
    const first = arrayValue([1]);
    const equal = arrayValue([1]);
    const value = dictionaryValue([
      { key: first, value: "first" },
      { key: "middle", value: 2 },
      { key: equal, value: "last" },
    ]);

    expect(value.entries).toHaveLength(2);
    expect(value.entries[0]).toEqual({ key: first, value: "last" });
    expect(getDictionaryEntry(value, equal)).toBe("last");
  });

  it("compares immutable data deeply and functions by identity", () => {
    const left = dictionaryValue([{ key: arrayValue([1]), value: dictionaryValue([{ key: "x", value: 2 }]) }]);
    const right = dictionaryValue([{ key: arrayValue([1]), value: dictionaryValue([{ key: "x", value: 2 }]) }]);
    const firstFunction = nativeFunction(() => null);
    const secondFunction = nativeFunction(() => null);

    expect(runtimeEquals(left, right)).toBe(true);
    expect(runtimeEquals(firstFunction, firstFunction)).toBe(true);
    expect(runtimeEquals(firstFunction, secondFunction)).toBe(false);
  });

  it("rejects non-finite primitives and mutable or forged composites", () => {
    expect(isRuntimeValue(Number.NaN)).toBe(false);
    expect(isRuntimeValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRuntimeValue({ kind: "array", elements: [] })).toBe(false);
    expect(isRuntimeValue(Object.freeze({ kind: "array", elements: [] }))).toBe(false);
    expect(isRuntimeValue(Object.freeze({ kind: "function" }))).toBe(false);
    expect(isRuntimeValue(Object.freeze({
      get kind() { return "array"; },
      elements: Object.freeze([]),
    }))).toBe(false);
    expect(() => arrayValue([Number.NaN as RuntimeValue])).toThrow(TypeError);
    expect(() => dictionaryValue([{ key: "bad", value: Number.NaN as RuntimeValue }])).toThrow(TypeError);
    expect(() => nativeFunction(() => null, { arity: -1 })).toThrow(RangeError);
  });

  it("rejects duplicate keys and cycles supplied by a host", () => {
    const duplicate = Object.freeze({
      kind: "dictionary" as const,
      entries: Object.freeze([
        Object.freeze({ key: arrayValue([1]), value: 1 }),
        Object.freeze({ key: arrayValue([1]), value: 2 }),
      ]),
    });
    expect(isRuntimeValue(duplicate)).toBe(false);

    const entries: Array<{ readonly key: RuntimeValue; readonly value: RuntimeValue }> = [];
    const cyclic = { kind: "dictionary" as const, entries };
    entries.push(Object.freeze({ key: "self", value: cyclic }));
    Object.freeze(entries);
    Object.freeze(cyclic);
    expect(isRuntimeValue(cyclic)).toBe(false);

    const keyEntries: Array<{ readonly key: RuntimeValue; readonly value: RuntimeValue }> = [];
    const cyclicKey = { kind: "dictionary" as const, entries: keyEntries };
    keyEntries.push(Object.freeze({ key: cyclicKey, value: "value" }));
    Object.freeze(keyEntries);
    Object.freeze(cyclicKey);
    expect(isRuntimeValue(cyclicKey)).toBe(false);
  });

  it("validates deeply nested immutable values without host recursion", () => {
    let value: RuntimeValue = null;
    for (let depth = 0; depth < 10_000; depth += 1) {
      value = arrayValue([value]);
    }

    expect(isRuntimeValue(value)).toBe(true);
  });

  it("compares deeply nested dictionary keys without host recursion", () => {
    let leftKey: RuntimeValue = null;
    let rightKey: RuntimeValue = null;
    for (let depth = 0; depth < 10_000; depth += 1) {
      leftKey = dictionaryValue([{ key: "next", value: leftKey }]);
      rightKey = dictionaryValue([{ key: "next", value: rightKey }]);
    }

    const dictionary = dictionaryValue([{ key: leftKey, value: "found" }]);
    expect(runtimeEquals(leftKey, rightKey)).toBe(true);
    expect(getDictionaryEntry(dictionary, rightKey)).toBe("found");
  });
});
