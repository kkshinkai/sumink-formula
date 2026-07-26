import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseCommandLine } from "./command-line.js";

describe("parseCommandLine", () => {
  it.each([
    [["program.sumi"], { ok: true, command: { kind: "run", file: "program.sumi" } }],
    [["folder/example.sumi"], { ok: true, command: { kind: "run", file: "folder/example.sumi" } }],
    [["--", "-program.sumi"], { ok: true, command: { kind: "run", file: "-program.sumi" } }],
    [["--help"], { ok: true, command: { kind: "help" } }],
    [["-h"], { ok: true, command: { kind: "help" } }],
  ] as const)("parses %j", (arguments_, expected) => {
    expect(parseCommandLine(arguments_)).toEqual(expected);
  });

  it.each([
    [[], ["Expected one .sumi source file."]],
    [["--unknown"], ["Unknown option '--unknown'.", "Expected one .sumi source file."]],
    [["one.sumi", "two.sumi"], ["Expected one source file, but received 2."]],
    [["--help", "program.sumi"], ["The help option cannot be combined with a source file."]],
    [["-"], ["Unknown option '-'.", "Expected one .sumi source file."]],
  ] as const)("diagnoses %j", (arguments_, messages) => {
    const result = parseCommandLine(arguments_);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(messages);
  });

  it("never throws for arbitrary argument vectors", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 50 }), (arguments_) => {
        expect(() => parseCommandLine(arguments_)).not.toThrow();
      }),
      { numRuns: 2_000, seed: 0xc11a9 },
    );
  });
});
