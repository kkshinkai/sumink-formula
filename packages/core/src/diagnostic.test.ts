import { describe, expect, it } from "vitest";

import { diagnostic, sortDiagnostics } from "./diagnostic.js";
import { textRange } from "./text.js";

describe("diagnostics", () => {
  it("has a stable source and phase ordering", () => {
    const values = [
      diagnostic("SF3000", "resolve", "resolve", textRange(10, 11)),
      diagnostic("SF2000", "parse", "parse", textRange(0, 1)),
      diagnostic("SF1000", "lex", "lex", textRange(0, 1)),
      diagnostic("SF2001", "parse", "shorter", textRange(0, 0)),
    ];

    expect(sortDiagnostics(values).map((entry) => entry.code)).toEqual([
      "SF2001",
      "SF1000",
      "SF2000",
      "SF3000",
    ]);
    expect(values.map((entry) => entry.code)).toEqual(["SF3000", "SF2000", "SF1000", "SF2001"]);
  });
});
