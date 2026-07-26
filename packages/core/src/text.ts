/** A half-open UTF-16 source range: `[start, end)`. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface SourcePosition {
  /** Zero-based UTF-16 offset. */
  readonly offset: number;
  /** Zero-based line. */
  readonly line: number;
  /** Zero-based UTF-16 column. */
  readonly column: number;
}

export function textRange(start: number, end: number): TextRange {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`Invalid text range [${start}, ${end})`);
  }

  return { start, end };
}

export function textRangeLength(range: TextRange): number {
  return range.end - range.start;
}

/**
 * Immutable source text with the offset convention shared by JavaScript,
 * ProseMirror, and LSP: every offset is measured in UTF-16 code units.
 */
export class SourceText {
  readonly #text: string;
  #lineStarts: readonly number[] | undefined;

  public constructor(text: string) {
    this.#text = text;
  }

  public get length(): number {
    return this.#text.length;
  }

  public toString(): string {
    return this.#text;
  }

  public slice(range: TextRange): string {
    if (range.end < range.start) {
      throw new RangeError(`Invalid text range [${range.start}, ${range.end})`);
    }
    this.#assertOffset(range.start, true);
    this.#assertOffset(range.end, true);
    return this.#text.slice(range.start, range.end);
  }

  public codeUnitAt(offset: number): number | undefined {
    this.#assertOffset(offset, true);
    return offset === this.length ? undefined : this.#text.charCodeAt(offset);
  }

  public positionAt(offset: number): SourcePosition {
    this.#assertOffset(offset, true);
    const lineStarts = this.#getLineStarts();
    let low = 0;
    let high = lineStarts.length;

    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const lineStart = lineStarts[middle];
      if (lineStart !== undefined && lineStart <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    const line = Math.max(0, low - 1);
    const lineStart = lineStarts[line] ?? 0;
    return { offset, line, column: offset - lineStart };
  }

  public rangeFromOffsets(start: number, end: number): TextRange {
    this.#assertOffset(start, true);
    this.#assertOffset(end, true);
    return textRange(start, end);
  }

  #assertOffset(offset: number, allowEnd = false): void {
    const maximum = allowEnd ? this.length : Math.max(0, this.length - 1);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
      throw new RangeError(`Source offset ${offset} is outside [0, ${maximum}]`);
    }
  }

  #getLineStarts(): readonly number[] {
    if (this.#lineStarts !== undefined) {
      return this.#lineStarts;
    }

    const starts: number[] = [0];
    for (let offset = 0; offset < this.#text.length; offset += 1) {
      const codeUnit = this.#text.charCodeAt(offset);
      if (codeUnit === 0x0d) {
        if (this.#text.charCodeAt(offset + 1) === 0x0a) {
          offset += 1;
        }
        starts.push(offset + 1);
      } else if (codeUnit === 0x0a) {
        starts.push(offset + 1);
      }
    }

    this.#lineStarts = starts;
    return starts;
  }
}
