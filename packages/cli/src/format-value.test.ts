import {
  arrayValue,
  dictionaryValue,
  nativeFunction,
  type RuntimeValue,
} from "@sumink-formula/core";
import { describe, expect, it } from "vitest";

import { formatPrintValue } from "./format-value.js";

describe("formatPrintValue", () => {
  it.each([
    [null, "null"],
    [true, "true"],
    [false, "false"],
    [42, "42"],
    [-0, "-0"],
    ["plain text", "plain text"],
    ["line one\nline two", "line one\nline two"],
  ] satisfies readonly (readonly [RuntimeValue, string])[])("formats %o", (value, expected) => {
    expect(formatPrintValue(value)).toBe(expected);
  });

  it("uses a deterministic recursive representation for arrays and dictionaries", () => {
    const value = dictionaryValue([
      { key: "message", value: "hello\nworld" },
      { key: "items", value: arrayValue([1, true, null, "text"]) },
      { key: arrayValue(["computed"]), value: dictionaryValue([{ key: "nested", value: -0 }]) },
    ]);

    expect(formatPrintValue(value)).toBe(
      "{\"message\": \"hello\\nworld\", \"items\": [1, true, null, \"text\"], "
      + "[[\"computed\"]]: {\"nested\": -0}}",
    );
  });

  it("describes every public function shape", () => {
    expect(formatPrintValue(nativeFunction(() => null))).toBe("<function>");
    expect(formatPrintValue(nativeFunction(() => null, { name: "write" }))).toBe("<function write>");
    expect(formatPrintValue(nativeFunction(() => null, { arity: 2 }))).toBe("<function/2>");
    expect(formatPrintValue(nativeFunction(() => null, { name: "write", arity: 2 })))
      .toBe("<function write/2>");
  });
});
