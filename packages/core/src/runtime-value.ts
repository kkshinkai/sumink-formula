export type RuntimeValue = null | boolean | number | string | ArrayValue | ObjectValue | FunctionValue;

export interface ArrayValue {
  readonly kind: "array";
  readonly elements: readonly RuntimeValue[];
}

export interface ObjectField {
  readonly key: string;
  readonly value: RuntimeValue;
}

export interface ObjectValue {
  readonly kind: "object";
  readonly fields: readonly ObjectField[];
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
  const value = Object.freeze({ kind: "array", elements: Object.freeze([...elements]) });
  if (!isRuntimeValue(value)) {
    throw new TypeError("An array runtime value contains an invalid element.");
  }
  return value;
}

export function objectValue(fields: readonly ObjectField[]): ObjectValue {
  const unique = new Map<string, RuntimeValue>();
  for (const field of fields) {
    unique.set(field.key, field.value);
  }
  const value = Object.freeze({
    kind: "object",
    fields: Object.freeze([...unique].map(([key, value]) => Object.freeze({ key, value }))),
  });
  if (!isRuntimeValue(value)) {
    throw new TypeError("An object runtime value contains an invalid field.");
  }
  return value;
}

export function getObjectField(object: ObjectValue, key: string): RuntimeValue | undefined {
  return object.fields.find((field) => field.key === key)?.value;
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

export function isObjectValue(value: RuntimeValue): value is ObjectValue {
  return typeof value === "object" && value !== null
    && value.kind === "object" && Array.isArray(value.fields);
}

export function isFunctionValue(value: RuntimeValue): value is FunctionValue {
  return typeof value === "object" && value !== null && value.kind === "function";
}

/**
 * Validates the public host boundary, including the immutability and finiteness
 * invariants that TypeScript's structural types cannot enforce at runtime.
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
        case "object": {
          const fields = ownDataProperty(current, "fields");
          if (!Array.isArray(fields) || !Object.isFrozen(fields)) {
            return false;
          }
          const keys = new Set<string>();
          for (let index = fields.length - 1; index >= 0; index -= 1) {
            const field: unknown = ownDataProperty(fields, String(index));
            if (typeof field !== "object" || field === null || !Object.isFrozen(field)) {
              return false;
            }
            const key = ownDataProperty(field, "key");
            const fieldValue = ownDataProperty(field, "value");
            if (typeof key !== "string" || fieldValue === undefined || keys.has(key)) {
              return false;
            }
            keys.add(key);
            work.push({ value: fieldValue, exit: false });
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
