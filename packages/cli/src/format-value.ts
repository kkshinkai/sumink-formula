import {
  isArrayValue,
  isDictionaryValue,
  isFunctionValue,
  type FunctionValue,
  type RuntimeValue,
} from "@sumink-formula/core";

/** Formats the argument to print. Top-level text is written without quotes. */
export function formatPrintValue(value: RuntimeValue): string {
  return typeof value === "string" ? value : formatNestedValue(value);
}

function formatNestedValue(value: RuntimeValue): string {
  if (value === null) {
    return "nil";
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "number") {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (isArrayValue(value)) {
    return `[${value.elements.map(formatNestedValue).join(", ")}]`;
  }
  if (isDictionaryValue(value)) {
    return `{${value.entries
      .map((entry) => `${formatDictionaryKey(entry.key)}: ${formatNestedValue(entry.value)}`)
      .join(", ")}}`;
  }
  if (isFunctionValue(value)) {
    return formatFunction(value);
  }
  return assertNever(value);
}

function formatDictionaryKey(value: RuntimeValue): string {
  return typeof value === "string"
    ? JSON.stringify(value)
    : `[${formatNestedValue(value)}]`;
}

function formatFunction(value: FunctionValue): string {
  if (value.name !== undefined && value.arity !== undefined) {
    return `<function ${value.name}/${value.arity}>`;
  }
  if (value.name !== undefined) {
    return `<function ${value.name}>`;
  }
  if (value.arity !== undefined) {
    return `<function/${value.arity}>`;
  }
  return "<function>";
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported runtime value: ${String(value)}`);
}
