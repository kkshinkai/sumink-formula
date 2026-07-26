import { describe, expect, it } from "vitest";

import {
  arrayValue,
  isRuntimeValue,
  nativeFunction,
  objectValue,
  type RuntimeValue,
} from "./runtime-value.js";

describe("runtime value boundary", () => {
  it("accepts values created by the public factories", () => {
    const value = objectValue([
      { key: "items", value: arrayValue([null, true, 1, "text"]) },
      { key: "run", value: nativeFunction(() => null) },
    ]);

    expect(isRuntimeValue(value)).toBe(true);
  });

  it("rejects non-finite primitives and mutable or forged composites", () => {
    expect(isRuntimeValue(Number.NaN)).toBe(false);
    expect(isRuntimeValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRuntimeValue({ kind: "array", elements: [] })).toBe(false);
    expect(isRuntimeValue(Object.freeze({
      kind: "array",
      elements: [],
    }))).toBe(false);
    expect(isRuntimeValue(Object.freeze({ kind: "function" }))).toBe(false);
    expect(isRuntimeValue(Object.freeze({
      get kind() { return "array"; },
      elements: Object.freeze([]),
    }))).toBe(false);
    const accessorElements: unknown[] = [];
    Object.defineProperty(accessorElements, "0", { get: () => null, enumerable: true });
    Object.freeze(accessorElements);
    expect(isRuntimeValue(Object.freeze({ kind: "array", elements: accessorElements }))).toBe(false);
    expect(() => arrayValue([Number.NaN as RuntimeValue])).toThrow(TypeError);
    expect(() => objectValue([{ key: "bad", value: Number.NaN as RuntimeValue }])).toThrow(TypeError);
    expect(() => nativeFunction(() => null, { arity: -1 })).toThrow(RangeError);
  });

  it("rejects cycles without overflowing the host stack", () => {
    const elements: RuntimeValue[] = [];
    const value = { kind: "array" as const, elements };
    elements.push(value);
    Object.freeze(elements);
    Object.freeze(value);

    expect(isRuntimeValue(value)).toBe(false);
  });

  it("validates deeply nested immutable values without recursion", () => {
    let value: RuntimeValue = null;
    for (let depth = 0; depth < 10_000; depth += 1) {
      value = arrayValue([value]);
    }

    expect(isRuntimeValue(value)).toBe(true);
  });
});
