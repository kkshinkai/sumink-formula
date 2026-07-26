import { describe, expect, it } from "vitest";

import { SourceText, textRange } from "./text.js";

describe("SourceText", () => {
  it("maps UTF-16 offsets across LF, CRLF, and astral code points", () => {
    const source = new SourceText("a😀\r\nb\nc");

    expect(source.positionAt(0)).toEqual({ offset: 0, line: 0, column: 0 });
    expect(source.positionAt(3)).toEqual({ offset: 3, line: 0, column: 3 });
    expect(source.positionAt(5)).toEqual({ offset: 5, line: 1, column: 0 });
    expect(source.positionAt(source.length)).toEqual({ offset: 8, line: 2, column: 1 });
  });

  it("rejects invalid ranges rather than silently clipping them", () => {
    const source = new SourceText("abc");

    expect(() => source.slice(textRange(0, 4))).toThrow(RangeError);
    expect(() => textRange(2, 1)).toThrow(RangeError);
  });
});
