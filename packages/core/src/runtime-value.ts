export type RuntimeValue = null | boolean | number | string | ArrayValue | DictionaryValue | FunctionValue;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

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

/** Copies JSON-shaped host data into Sumi's closed immutable value model. */
export function runtimeValueFromJson(value: JsonValue): RuntimeValue {
  try {
    return convertJsonValue(value);
  } catch (error: unknown) {
    if (error instanceof JsonConversionFailure) {
      throw new TypeError(error.message);
    }
    throw new TypeError("Failed to inspect the host JSON value.");
  }
}

type JsonConversionFrame =
  | {
      readonly kind: "visit";
      readonly source: unknown;
      readonly assign: (value: RuntimeValue) => void;
    }
  | {
      readonly kind: "finish-array";
      readonly source: readonly unknown[];
      readonly elements: (RuntimeValue | undefined)[];
      readonly assign: (value: RuntimeValue) => void;
    }
  | {
      readonly kind: "finish-object";
      readonly source: object;
      readonly keys: readonly string[];
      readonly values: (RuntimeValue | undefined)[];
      readonly assign: (value: RuntimeValue) => void;
    };

class JsonConversionFailure extends Error {}

function convertJsonValue(source: unknown): RuntimeValue {
  let result: RuntimeValue | undefined;
  let assigned = false;
  const active = new WeakSet<object>();
  const converted = new WeakMap<object, RuntimeValue>();
  const frames: JsonConversionFrame[] = [{
    kind: "visit",
    source,
    assign: (value) => {
      result = value;
      assigned = true;
    },
  }];

  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) {
      continue;
    }

    if (frame.kind === "finish-array") {
      const elements = frame.elements.map((element) => {
        if (element === undefined) {
          throw new JsonConversionFailure("A JSON array element was not converted.");
        }
        return element;
      });
      const value = arrayValue(elements);
      active.delete(frame.source);
      converted.set(frame.source, value);
      frame.assign(value);
      continue;
    }

    if (frame.kind === "finish-object") {
      const entries = frame.keys.map((key, index): RuntimeDictionaryEntry => {
        const value = frame.values[index];
        if (value === undefined) {
          throw new JsonConversionFailure(`JSON property '${key}' was not converted.`);
        }
        return { key, value };
      });
      const value = dictionaryValue(entries);
      active.delete(frame.source);
      converted.set(frame.source, value);
      frame.assign(value);
      continue;
    }

    const current = frame.source;
    if (
      current === null
      || typeof current === "boolean"
      || typeof current === "string"
    ) {
      frame.assign(current);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new JsonConversionFailure("A JSON number must be finite.");
      }
      frame.assign(current);
      continue;
    }
    if (typeof current !== "object") {
      throw new JsonConversionFailure(`JSON values cannot contain ${typeof current}.`);
    }

    const prior = converted.get(current);
    if (prior !== undefined) {
      frame.assign(prior);
      continue;
    }
    if (active.has(current)) {
      throw new JsonConversionFailure("JSON values cannot contain cycles.");
    }

    if (Array.isArray(current)) {
      validateJsonArray(current);
      active.add(current);
      const elements: (RuntimeValue | undefined)[] = new Array(current.length);
      frames.push({ kind: "finish-array", source: current, elements, assign: frame.assign });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const elementIndex = index;
        frames.push({
          kind: "visit",
          source: current[elementIndex],
          assign: (value) => {
            elements[elementIndex] = value;
          },
        });
      }
      continue;
    }

    validateJsonObject(current);
    active.add(current);
    const keys = Object.keys(current);
    const values: (RuntimeValue | undefined)[] = new Array(keys.length);
    frames.push({ kind: "finish-object", source: current, keys, values, assign: frame.assign });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const valueIndex = index;
      const key = keys[valueIndex];
      if (key === undefined) {
        throw new JsonConversionFailure("A JSON object key became unavailable.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new JsonConversionFailure(`JSON property '${key}' must be a data property.`);
      }
      frames.push({
        kind: "visit",
        source: descriptor.value,
        assign: (value) => {
          values[valueIndex] = value;
        },
      });
    }
  }

  if (!assigned || result === undefined) {
    throw new JsonConversionFailure("The JSON value did not produce a runtime value.");
  }
  return result;
}

function validateJsonArray(value: readonly unknown[]): void {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !isCanonicalArrayIndex(key, value.length)) {
      throw new JsonConversionFailure("JSON arrays cannot contain custom properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new JsonConversionFailure("JSON array elements must be enumerable data properties.");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new JsonConversionFailure("JSON arrays cannot contain holes.");
    }
  }
}

function validateJsonObject(value: object): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JsonConversionFailure("A JSON object must have a plain or null prototype.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new JsonConversionFailure("JSON objects cannot contain symbol properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) {
      throw new JsonConversionFailure(`JSON property '${key}' must be an enumerable data property.`);
    }
  }
}

function isCanonicalArrayIndex(value: string, length: number): boolean {
  const index = Number(value);
  return Number.isSafeInteger(index)
    && index >= 0
    && index < length
    && String(index) === value;
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
