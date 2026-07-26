export type RuntimeValue = null | boolean | number | string | ArrayValue | DictionaryValue | FunctionValue;

export interface ArrayValue {
  readonly kind: "array";
  readonly elements: readonly RuntimeValue[];
}

export interface RuntimeDictionaryEntry {
  readonly key: RuntimeValue;
  readonly value: RuntimeValue;
}

export interface DictionaryValue {
  readonly kind: "dictionary";
  readonly entries: readonly RuntimeDictionaryEntry[];
}

export interface FunctionValue {
  readonly kind: "function";
  readonly name?: string;
  readonly arity?: number;
}

export interface NativeFunctionContext {
  readonly arguments: readonly RuntimeValue[];
}

export type NativeFunctionImplementation = (context: NativeFunctionContext) => RuntimeValue;

export function arrayValue(elements: readonly RuntimeValue[]): ArrayValue {
  const value = Object.freeze({ kind: "array" as const, elements: Object.freeze([...elements]) });
  if (!isRuntimeValue(value)) {
    throw new TypeError("An array runtime value contains an invalid element.");
  }
  return value;
}

export function dictionaryValue(entries: readonly RuntimeDictionaryEntry[]): DictionaryValue {
  const unique: RuntimeDictionaryEntry[] = [];
  for (const entry of entries) {
    if (!isRuntimeValue(entry.key) || !isRuntimeValue(entry.value)) {
      throw new TypeError("A dictionary runtime value contains an invalid entry.");
    }
    const existing = unique.findIndex((candidate) => runtimeEquals(candidate.key, entry.key));
    if (existing === -1) {
      unique.push(Object.freeze({ key: entry.key, value: entry.value }));
    } else {
      const first = unique[existing];
      if (first === undefined) {
        throw new Error("Dictionary entry index became invalid.");
      }
      unique[existing] = Object.freeze({ key: first.key, value: entry.value });
    }
  }

  const value = Object.freeze({
    kind: "dictionary" as const,
    entries: Object.freeze(unique),
  });
  if (!isRuntimeValue(value)) {
    throw new TypeError("Failed to construct a dictionary runtime value.");
  }
  return value;
}

export function getDictionaryEntry(
  dictionary: DictionaryValue,
  key: RuntimeValue,
): RuntimeValue | undefined {
  return dictionary.entries.find((entry) => runtimeEquals(entry.key, key))?.value;
}

interface NativeCallable {
  readonly kind: "native";
  readonly implementation: NativeFunctionImplementation;
}

const callableStates = new WeakMap<FunctionValue, NativeCallable | object>();
const validatedRuntimeValues = new WeakSet<object>();

export function nativeFunction(
  implementation: NativeFunctionImplementation,
  options: { readonly name?: string; readonly arity?: number } = {},
): FunctionValue {
  if (typeof implementation !== "function") {
    throw new TypeError("A native function implementation must be callable.");
  }
  if (options.name !== undefined && typeof options.name !== "string") {
    throw new TypeError("A native function name must be a string.");
  }
  if (options.arity !== undefined
    && (!Number.isSafeInteger(options.arity) || options.arity < 0)) {
    throw new RangeError("A native function arity must be a non-negative safe integer.");
  }
  const value: FunctionValue = options.name === undefined
    ? (options.arity === undefined
      ? { kind: "function" }
      : { kind: "function", arity: options.arity })
    : (options.arity === undefined
      ? { kind: "function", name: options.name }
      : { kind: "function", name: options.name, arity: options.arity });
  Object.freeze(value);
  callableStates.set(value, Object.freeze({ kind: "native", implementation }));
  if (!isRuntimeValue(value)) {
    throw new TypeError("Failed to construct a native function runtime value.");
  }
  return value;
}

/** @internal Registers evaluator-owned closure state without exposing its environment. */
export function registerClosure(value: FunctionValue, state: object): void {
  callableStates.set(value, state);
}

/** @internal */
export function callableState(value: FunctionValue): NativeCallable | object | undefined {
  return callableStates.get(value);
}

export function isArrayValue(value: RuntimeValue): value is ArrayValue {
  return typeof value === "object" && value !== null
    && value.kind === "array" && Array.isArray(value.elements);
}

export function isDictionaryValue(value: RuntimeValue): value is DictionaryValue {
  return typeof value === "object" && value !== null
    && value.kind === "dictionary" && Array.isArray(value.entries);
}

export function isFunctionValue(value: RuntimeValue): value is FunctionValue {
  return typeof value === "object" && value !== null && value.kind === "function";
}

/** Structural equality for immutable data; functions compare by identity. */
export function runtimeEquals(left: RuntimeValue, right: RuntimeValue): boolean {
  type EqualityFrame =
    | { readonly kind: "compare"; readonly left: RuntimeValue; readonly right: RuntimeValue }
    | { readonly kind: "array-next"; readonly left: ArrayValue; readonly right: ArrayValue; readonly index: number }
    | { readonly kind: "array-after"; readonly left: ArrayValue; readonly right: ArrayValue; readonly index: number }
    | {
        readonly kind: "dictionary-next";
        readonly left: DictionaryValue;
        readonly right: DictionaryValue;
        readonly entryIndex: number;
      }
    | {
        readonly kind: "dictionary-candidate";
        readonly left: DictionaryValue;
        readonly right: DictionaryValue;
        readonly entryIndex: number;
        readonly candidateIndex: number;
      }
    | {
        readonly kind: "dictionary-candidate-after";
        readonly left: DictionaryValue;
        readonly right: DictionaryValue;
        readonly entryIndex: number;
        readonly candidateIndex: number;
      }
    | {
        readonly kind: "dictionary-value-after";
        readonly left: DictionaryValue;
        readonly right: DictionaryValue;
        readonly entryIndex: number;
      };

  const work: EqualityFrame[] = [{ kind: "compare", left, right }];
  let equal = true;

  while (work.length > 0) {
    const frame = work.pop();
    if (frame === undefined) {
      continue;
    }

    switch (frame.kind) {
      case "compare": {
        if (frame.left === frame.right) {
          equal = true;
        } else if (isArrayValue(frame.left) && isArrayValue(frame.right)) {
          if (frame.left.elements.length !== frame.right.elements.length) {
            equal = false;
          } else {
            work.push({ kind: "array-next", left: frame.left, right: frame.right, index: 0 });
          }
        } else if (isDictionaryValue(frame.left) && isDictionaryValue(frame.right)) {
          if (frame.left.entries.length !== frame.right.entries.length) {
            equal = false;
          } else {
            work.push({
              kind: "dictionary-next",
              left: frame.left,
              right: frame.right,
              entryIndex: 0,
            });
          }
        } else {
          equal = false;
        }
        break;
      }
      case "array-next": {
        if (frame.index === frame.left.elements.length) {
          equal = true;
          break;
        }
        const leftElement = frame.left.elements[frame.index];
        const rightElement = frame.right.elements[frame.index];
        if (leftElement === undefined || rightElement === undefined) {
          equal = false;
          break;
        }
        work.push({ ...frame, kind: "array-after" });
        work.push({ kind: "compare", left: leftElement, right: rightElement });
        break;
      }
      case "array-after":
        if (equal) {
          work.push({ kind: "array-next", left: frame.left, right: frame.right, index: frame.index + 1 });
        }
        break;
      case "dictionary-next":
        if (frame.entryIndex === frame.left.entries.length) {
          equal = true;
        } else {
          work.push({
            kind: "dictionary-candidate",
            left: frame.left,
            right: frame.right,
            entryIndex: frame.entryIndex,
            candidateIndex: 0,
          });
        }
        break;
      case "dictionary-candidate": {
        const leftEntry = frame.left.entries[frame.entryIndex];
        const rightEntry = frame.right.entries[frame.candidateIndex];
        if (leftEntry === undefined || rightEntry === undefined) {
          equal = false;
          break;
        }
        work.push({ ...frame, kind: "dictionary-candidate-after" });
        work.push({ kind: "compare", left: leftEntry.key, right: rightEntry.key });
        break;
      }
      case "dictionary-candidate-after":
        if (equal) {
          const leftEntry = frame.left.entries[frame.entryIndex];
          const rightEntry = frame.right.entries[frame.candidateIndex];
          if (leftEntry === undefined || rightEntry === undefined) {
            equal = false;
            break;
          }
          work.push({
            kind: "dictionary-value-after",
            left: frame.left,
            right: frame.right,
            entryIndex: frame.entryIndex,
          });
          work.push({ kind: "compare", left: leftEntry.value, right: rightEntry.value });
        } else if (frame.candidateIndex + 1 < frame.right.entries.length) {
          work.push({
            kind: "dictionary-candidate",
            left: frame.left,
            right: frame.right,
            entryIndex: frame.entryIndex,
            candidateIndex: frame.candidateIndex + 1,
          });
        }
        break;
      case "dictionary-value-after":
        if (equal) {
          work.push({
            kind: "dictionary-next",
            left: frame.left,
            right: frame.right,
            entryIndex: frame.entryIndex + 1,
          });
        }
        break;
    }
  }
  return equal;
}

/**
 * Validates the public host boundary, including the immutability, acyclicity,
 * finiteness, and unique-key invariants that structural TypeScript types cannot enforce.
 */
export function isRuntimeValue(value: unknown): value is RuntimeValue {
  type WorkItem = { readonly value: unknown; readonly exit: boolean };
  const visiting = new WeakSet<object>();
  const work: WorkItem[] = [{ value, exit: false }];

  try {
    while (work.length > 0) {
      const item = work.pop();
      if (item === undefined) {
        continue;
      }
      const current = item.value;
      if (current === null || typeof current === "boolean" || typeof current === "string") {
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          return false;
        }
        continue;
      }
      if (typeof current !== "object") {
        return false;
      }
      if (validatedRuntimeValues.has(current)) {
        continue;
      }
      if (item.exit) {
        const runtimeCurrent = current as RuntimeValue;
        if (isDictionaryValue(runtimeCurrent) && hasDuplicateKeys(runtimeCurrent.entries)) {
          return false;
        }
        visiting.delete(current);
        validatedRuntimeValues.add(current);
        continue;
      }
      if (visiting.has(current) || !Object.isFrozen(current)) {
        return false;
      }

      visiting.add(current);
      work.push({ value: current, exit: true });
      const kind = ownDataProperty(current, "kind");
      if (kind === undefined) {
        return false;
      }
      switch (kind) {
        case "array": {
          const elements = ownDataProperty(current, "elements");
          if (!Array.isArray(elements) || !Object.isFrozen(elements)) {
            return false;
          }
          for (let index = elements.length - 1; index >= 0; index -= 1) {
            const element = ownDataProperty(elements, String(index));
            if (element === undefined) {
              return false;
            }
            work.push({ value: element, exit: false });
          }
          break;
        }
        case "dictionary": {
          const entries = ownDataProperty(current, "entries");
          if (!Array.isArray(entries) || !Object.isFrozen(entries)) {
            return false;
          }
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = ownDataProperty(entries, String(index));
            if (typeof entry !== "object" || entry === null || !Object.isFrozen(entry)) {
              return false;
            }
            const key = ownDataProperty(entry, "key");
            const entryValue = ownDataProperty(entry, "value");
            if (key === undefined || entryValue === undefined) {
              return false;
            }
            work.push({ value: entryValue, exit: false });
            work.push({ value: key, exit: false });
          }
          break;
        }
        case "function": {
          const name = optionalOwnDataProperty(current, "name");
          const arity = optionalOwnDataProperty(current, "arity");
          if (name.invalid || (name.present && typeof name.value !== "string")
            || arity.invalid
            || (arity.present
              && (!Number.isSafeInteger(arity.value) || (arity.value as number) < 0))
            || !callableStates.has(current as FunctionValue)) {
            return false;
          }
          break;
        }
        default:
          return false;
      }
    }
    return true;
  } catch {
    // Proxies and accessors supplied by the host are not runtime values.
    return false;
  }
}

function hasDuplicateKeys(entries: readonly RuntimeDictionaryEntry[]): boolean {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      return true;
    }
    for (let candidate = index + 1; candidate < entries.length; candidate += 1) {
      const other = entries[candidate];
      if (other === undefined || runtimeEquals(entry.key, other.key)) {
        return true;
      }
    }
  }
  return false;
}

function ownDataProperty(value: object, key: PropertyKey): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function optionalOwnDataProperty(
  value: object,
  key: PropertyKey,
): { readonly present: boolean; readonly invalid: boolean; readonly value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { present: false, invalid: false };
  }
  return "value" in descriptor
    ? { present: true, invalid: false, value: descriptor.value }
    : { present: true, invalid: true };
}
