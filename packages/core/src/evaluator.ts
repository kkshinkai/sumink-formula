import type {
  ClosureExpression,
  Expression,
  InfixOperator,
  MatchSelectionExpression,
  Pattern,
  PrefixOperator,
  Program,
} from "./ast.js";
import {
  diagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type RelatedDiagnosticInformation,
} from "./diagnostic.js";
import type { BindingId, Resolution } from "./resolver.js";
import {
  arrayValue,
  callableState,
  getObjectField,
  isArrayValue,
  isFunctionValue,
  isObjectValue,
  isRuntimeValue,
  objectValue,
  registerClosure,
  type FunctionValue,
  type NativeFunctionImplementation,
  type ObjectField,
  type RuntimeValue,
} from "./runtime-value.js";
import type { TextRange } from "./text.js";

export interface EvaluateOptions {
  readonly globals?: ReadonlyMap<string, RuntimeValue> | Readonly<Record<string, RuntimeValue>>;
  /** Maximum number of expression evaluations. Defaults to 100,000. */
  readonly maxSteps?: number;
  /** Maximum nested formula call depth. Defaults to 512. */
  readonly maxCallDepth?: number;
}

export type EvaluationResult =
  | { readonly ok: true; readonly value: RuntimeValue; readonly usedDependencies: ReadonlySet<string> }
  | { readonly ok: false; readonly diagnostic: Diagnostic; readonly usedDependencies: ReadonlySet<string> };

export function evaluate(
  program: Program,
  resolution: Resolution,
  options: EvaluateOptions = {},
): EvaluationResult {
  const existingDiagnostic = resolution.diagnostics.find((entry) => entry.category === "error");
  if (existingDiagnostic !== undefined) {
    return { ok: false, diagnostic: existingDiagnostic, usedDependencies: new Set() };
  }

  return new Evaluator(
    resolution,
    normalizeGlobals(options.globals),
    normalizeLimit(options.maxSteps, 100_000, "maxSteps"),
    normalizeLimit(options.maxCallDepth, 512, "maxCallDepth"),
  ).evaluate(program);
}

class Slot {
  #initialized = false;
  #value: RuntimeValue = null;

  public get initialized(): boolean {
    return this.#initialized;
  }

  public read(): RuntimeValue {
    if (!this.#initialized) {
      throw new Error("Attempted to read an uninitialized slot directly.");
    }
    return this.#value;
  }

  public initialize(value: RuntimeValue): void {
    if (this.#initialized) {
      throw new Error("A lexical binding slot cannot be initialized twice.");
    }
    this.#value = value;
    this.#initialized = true;
  }
}

class Environment {
  readonly #parent: Environment | undefined;
  readonly #slots: ReadonlyMap<BindingId, Slot>;

  public constructor(parent?: Environment, slots: ReadonlyMap<BindingId, Slot> = new Map()) {
    this.#parent = parent;
    this.#slots = slots;
  }

  public slot(bindingId: BindingId): Slot | undefined {
    return this.#slots.get(bindingId) ?? this.#parent?.slot(bindingId);
  }
}

interface ClosureState {
  readonly kind: "closure";
  readonly expression: ClosureExpression;
  readonly environment: Environment;
  readonly resolution: Resolution;
  readonly globals: ReadonlyMap<string, RuntimeValue>;
  readonly owner: object;
}

class EvaluationFailure extends Error {
  public readonly diagnostic: Diagnostic;

  public constructor(value: Diagnostic) {
    super(value.message);
    this.name = "EvaluationFailure";
    this.diagnostic = value;
  }
}

class Evaluator {
  #resolution: Resolution;
  #globals: ReadonlyMap<string, RuntimeValue>;
  readonly #callStack: TextRange[] = [];
  readonly #usedDependencies = new Set<string>();
  readonly #maxSteps: number;
  readonly #maxCallDepth: number;
  readonly #evaluationOwner = Object.freeze({});
  #activeOwner: object;
  #trackExternalDependencies = true;
  #steps = 0;

  public constructor(
    resolution: Resolution,
    globals: ReadonlyMap<string, RuntimeValue>,
    maxSteps: number,
    maxCallDepth: number,
  ) {
    this.#resolution = resolution;
    this.#globals = globals;
    this.#maxSteps = maxSteps;
    this.#maxCallDepth = maxCallDepth;
    this.#activeOwner = this.#evaluationOwner;
  }

  public evaluate(program: Program): EvaluationResult {
    try {
      const root = new Environment();
      let result: RuntimeValue = null;
      for (const expression of program.expressions) {
        result = this.#expression(expression, root);
      }
      return { ok: true, value: result, usedDependencies: this.#usedDependencies };
    } catch (error: unknown) {
      if (error instanceof EvaluationFailure) {
        return { ok: false, diagnostic: error.diagnostic, usedDependencies: this.#usedDependencies };
      }
      return {
        ok: false,
        diagnostic: diagnostic(
          "SF4999",
          "evaluate",
          "Internal evaluator failure.",
          program.range,
        ),
        usedDependencies: this.#usedDependencies,
      };
    }
  }

  #expression(expression: Expression, environment: Environment): RuntimeValue {
    this.#steps += 1;
    if (this.#steps > this.#maxSteps) {
      return this.#fail(
        "SF4024",
        `Evaluation exceeded the step limit of ${this.#maxSteps}.`,
        expression.range,
      );
    }

    switch (expression.kind) {
      case "ErrorExpression":
        return this.#fail("SF4000", "Cannot evaluate an invalid expression.", expression.range);
      case "LiteralExpression":
        if (typeof expression.value === "number" && !Number.isFinite(expression.value)) {
          return this.#fail("SF4001", "Numeric literal is outside the finite number range.", expression.range);
        }
        return expression.value;
      case "IdentifierExpression": {
        const reference = this.#resolution.references.get(expression.id);
        if (reference === undefined) {
          return this.#fail("SF4002", "Identifier was not resolved.", expression.range);
        }
        if (reference.kind === "external") {
          if (this.#trackExternalDependencies) {
            this.#usedDependencies.add(reference.name);
          }
          if (!this.#globals.has(reference.name)) {
            return this.#fail(
              "SF4003",
              `No value was provided for external binding '${reference.name}'.`,
              expression.range,
            );
          }
          const value: unknown = this.#globals.get(reference.name);
          if (!isRuntimeValue(value)) {
            return this.#fail(
              "SF4026",
              `External binding '${reference.name}' is not a valid immutable runtime value.`,
              expression.range,
            );
          }
          return value;
        }

        const slot = environment.slot(reference.bindingId);
        if (slot === undefined) {
          return this.#fail("SF4004", "Resolved lexical binding has no runtime slot.", expression.range);
        }
        if (!slot.initialized) {
          return this.#fail(
            "SF4005",
            "A recursive let binding was read before it was initialized.",
            expression.range,
          );
        }
        return slot.read();
      }
      case "ArrayExpression":
        return arrayValue(expression.elements.map((element) => this.#expression(element, environment)));
      case "ObjectExpression": {
        const fields: ObjectField[] = [];
        for (const member of expression.members) {
          const key = member.key.kind === "StaticObjectKey"
            ? member.key.value
            : this.#objectKey(this.#expression(member.key.expression, environment), member.key.range);
          fields.push({ key, value: this.#expression(member.value, environment) });
        }
        return objectValue(fields);
      }
      case "CallExpression": {
        const callee = this.#expression(expression.callee, environment);
        const arguments_ = expression.arguments.map((argument) => this.#expression(argument, environment));
        return this.#call(callee, arguments_, expression.range);
      }
      case "GroupedExpression":
        return this.#expression(expression.expression, environment);
      case "ClosureExpression":
        return this.#closure(expression, environment);
      case "BlockExpression": {
        let value: RuntimeValue = null;
        for (const child of expression.expressions) {
          value = this.#expression(child, environment);
        }
        return value;
      }
      case "IfExpression":
        for (const branch of expression.branches) {
          const condition = this.#requireBoolean(
            this.#expression(branch.condition, environment),
            branch.condition.range,
          );
          if (condition) {
            return this.#expression(branch.result, environment);
          }
        }
        return this.#expression(expression.elseBranch, environment);
      case "PrefixOperatorExpression":
        return this.#prefix(
          expression.operator,
          this.#expression(expression.operand, environment),
          expression.range,
        );
      case "InfixOperatorExpression":
        return this.#infix(expression.operator, expression.left, expression.right, environment, expression.range);
      case "FieldSelectorExpression": {
        const receiver = this.#expression(expression.receiver, environment);
        if (!isObjectValue(receiver)) {
          return this.#fail("SF4006", "Field selection requires an object value.", expression.receiver.range);
        }
        return getObjectField(receiver, expression.field) ?? null;
      }
      case "ComputedSelectorExpression":
        return this.#select(
          this.#expression(expression.receiver, environment),
          this.#expression(expression.selector, environment),
          expression.range,
        );
      case "LetExpression": {
        const slots = new Map<BindingId, Slot>();
        for (const binding of expression.bindings) {
          this.#allocatePattern(binding.pattern, slots);
        }
        const recursiveEnvironment = new Environment(environment, slots);
        for (const binding of expression.bindings) {
          const value = this.#expression(binding.value, recursiveEnvironment);
          if (!this.#matchAndBind(binding.pattern, value, recursiveEnvironment)) {
            return this.#fail("SF4007", "Let binding pattern did not match its value.", binding.pattern.range);
          }
        }
        return this.#expression(expression.body, recursiveEnvironment);
      }
      case "MatchTestExpression": {
        const subject = this.#expression(expression.subject, environment);
        return this.#matches(expression.pattern, subject);
      }
      case "MatchSelectionExpression":
        return this.#matchSelection(expression, environment);
    }
  }

  #closure(expression: ClosureExpression, environment: Environment): FunctionValue {
    const value: FunctionValue = Object.freeze({
      kind: "function",
      arity: expression.parameters.length,
    });
    registerClosure(value, Object.freeze({
      kind: "closure",
      expression,
      environment,
      resolution: this.#resolution,
      globals: this.#globals,
      owner: this.#activeOwner,
    } satisfies ClosureState));
    return value;
  }

  #call(callee: RuntimeValue, arguments_: readonly RuntimeValue[], range: TextRange): RuntimeValue {
    if (!isFunctionValue(callee)) {
      return this.#fail("SF4008", "Only function values can be called.", range);
    }
    if (callee.arity !== undefined && callee.arity !== arguments_.length) {
      return this.#fail(
        "SF4009",
        `Expected ${callee.arity} arguments, but received ${arguments_.length}.`,
        range,
      );
    }

    const state = callableState(callee);
    if (state === undefined) {
      return this.#fail("SF4010", "Function value has no callable implementation.", range);
    }

    if (this.#callStack.length >= this.#maxCallDepth) {
      return this.#fail(
        "SF4025",
        `Evaluation exceeded the call-depth limit of ${this.#maxCallDepth}.`,
        range,
      );
    }

    this.#callStack.push(range);
    try {
      if (isNativeCallable(state)) {
        return this.#callNative(state.implementation, arguments_, range);
      }

      if (!isClosureState(state)) {
        return this.#fail("SF4998", "Invalid callable implementation state.", range);
      }
      const closure = state;
      const previousResolution = this.#resolution;
      const previousGlobals = this.#globals;
      const previousOwner = this.#activeOwner;
      const previousTracking = this.#trackExternalDependencies;
      this.#resolution = closure.resolution;
      this.#globals = closure.globals;
      this.#activeOwner = closure.owner;
      this.#trackExternalDependencies = closure.owner === this.#evaluationOwner;
      try {
        const slots = new Map<BindingId, Slot>();
        closure.expression.parameters.forEach((parameter) => this.#allocatePattern(parameter, slots));
        const callEnvironment = new Environment(closure.environment, slots);
        for (let index = 0; index < closure.expression.parameters.length; index += 1) {
          const parameter = closure.expression.parameters[index];
          if (parameter === undefined || !this.#matchAndBind(parameter, arguments_[index] ?? null, callEnvironment)) {
            return this.#fail("SF4011", `Argument ${index + 1} did not match its parameter pattern.`, range);
          }
        }
        return this.#expression(closure.expression.body, callEnvironment);
      } finally {
        this.#resolution = previousResolution;
        this.#globals = previousGlobals;
        this.#activeOwner = previousOwner;
        this.#trackExternalDependencies = previousTracking;
      }
    } finally {
      this.#callStack.pop();
    }
  }

  #callNative(
    implementation: NativeFunctionImplementation,
    arguments_: readonly RuntimeValue[],
    range: TextRange,
  ): RuntimeValue {
    try {
      const context = Object.freeze({ arguments: Object.freeze([...arguments_]) });
      const value: unknown = implementation(context);
      if (!isRuntimeValue(value)) {
        return this.#fail("SF4027", "Host function returned an invalid runtime value.", range);
      }
      return value;
    } catch (error: unknown) {
      if (error instanceof EvaluationFailure) {
        throw error;
      }
      return this.#fail("SF4012", "Host function failed.", range);
    }
  }

  #prefix(operator: PrefixOperator, value: RuntimeValue, range: TextRange): RuntimeValue {
    switch (operator) {
      case "-":
        return this.#finiteNumber(-this.#requireNumber(value, range), range);
      case "not":
        return !this.#requireBoolean(value, range);
    }
  }

  #infix(
    operator: InfixOperator,
    leftExpression: Expression,
    rightExpression: Expression,
    environment: Environment,
    range: TextRange,
  ): RuntimeValue {
    const left = this.#expression(leftExpression, environment);
    if (operator === "and") {
      return this.#requireBoolean(left, leftExpression.range)
        ? this.#requireBoolean(this.#expression(rightExpression, environment), rightExpression.range)
        : false;
    }
    if (operator === "or") {
      return this.#requireBoolean(left, leftExpression.range)
        ? true
        : this.#requireBoolean(this.#expression(rightExpression, environment), rightExpression.range);
    }

    const right = this.#expression(rightExpression, environment);
    switch (operator) {
      case "+":
        if (typeof left === "string" && typeof right === "string") {
          return left + right;
        }
        return this.#finiteNumber(
          this.#requireNumber(left, leftExpression.range) + this.#requireNumber(right, rightExpression.range),
          range,
        );
      case "-":
        return this.#finiteNumber(
          this.#requireNumber(left, leftExpression.range) - this.#requireNumber(right, rightExpression.range),
          range,
        );
      case "*":
        return this.#finiteNumber(
          this.#requireNumber(left, leftExpression.range) * this.#requireNumber(right, rightExpression.range),
          range,
        );
      case "/": {
        const divisor = this.#requireNumber(right, rightExpression.range);
        if (divisor === 0) {
          return this.#fail("SF4013", "Division by zero.", rightExpression.range);
        }
        return this.#finiteNumber(this.#requireNumber(left, leftExpression.range) / divisor, range);
      }
      case "%": {
        const divisor = this.#requireNumber(right, rightExpression.range);
        if (divisor === 0) {
          return this.#fail("SF4014", "Remainder by zero.", rightExpression.range);
        }
        return this.#finiteNumber(this.#requireNumber(left, leftExpression.range) % divisor, range);
      }
      case "<":
      case "<=":
      case ">":
      case ">=":
        return this.#compare(operator, left, right, range);
      case "==":
        return runtimeEquals(left, right);
      case "!=":
        return !runtimeEquals(left, right);
    }
  }

  #compare(
    operator: "<" | "<=" | ">" | ">=",
    left: RuntimeValue,
    right: RuntimeValue,
    range: TextRange,
  ): boolean {
    if (typeof left === "string" && typeof right === "string") {
      return comparePrimitive(operator, left, right);
    }
    if (typeof left === "number" && typeof right === "number") {
      return comparePrimitive(
        operator,
        this.#requireNumber(left, range),
        this.#requireNumber(right, range),
      );
    }
    return this.#fail("SF4015", "Comparison requires two finite numbers or two strings.", range);
  }

  #select(receiver: RuntimeValue, selector: RuntimeValue, range: TextRange): RuntimeValue {
    if (isArrayValue(receiver)) {
      if (typeof selector !== "number" || !Number.isSafeInteger(selector) || selector < 0) {
        return this.#fail("SF4016", "Array selection requires a non-negative integer index.", range);
      }
      return receiver.elements[selector] ?? null;
    }
    if (isObjectValue(receiver)) {
      if (typeof selector !== "string" && (typeof selector !== "number" || !Number.isFinite(selector))) {
        return this.#fail("SF4017", "Object selection requires a string or finite number key.", range);
      }
      return getObjectField(receiver, String(selector)) ?? null;
    }
    return this.#fail("SF4018", "Computed selection requires an array or object value.", range);
  }

  #matchSelection(expression: MatchSelectionExpression, environment: Environment): RuntimeValue {
    const subject = this.#expression(expression.subject, environment);
    for (const matchCase of expression.cases) {
      const slots = new Map<BindingId, Slot>();
      this.#allocatePattern(matchCase.pattern, slots);
      const caseEnvironment = new Environment(environment, slots);
      if (this.#matchAndBind(matchCase.pattern, subject, caseEnvironment)) {
        return this.#expression(matchCase.result, caseEnvironment);
      }
    }
    if (expression.elseBranch !== undefined) {
      return this.#expression(expression.elseBranch, environment);
    }
    return this.#fail("SF4019", "No match case accepted the value.", expression.range);
  }

  #allocatePattern(pattern: Pattern, slots: Map<BindingId, Slot>): void {
    if (pattern.kind !== "IdentifierPattern") {
      return;
    }
    const bindingId = this.#resolution.bindings.get(pattern.id);
    if (bindingId !== undefined) {
      slots.set(bindingId, new Slot());
    }
  }

  #matchAndBind(pattern: Pattern, value: RuntimeValue, environment: Environment): boolean {
    if (!this.#matches(pattern, value)) {
      return false;
    }
    if (pattern.kind === "IdentifierPattern") {
      const bindingId = this.#resolution.bindings.get(pattern.id);
      if (bindingId === undefined) {
        return false;
      }
      const slot = environment.slot(bindingId);
      if (slot === undefined) {
        return false;
      }
      slot.initialize(value);
    }
    return true;
  }

  #matches(pattern: Pattern, value: RuntimeValue): boolean {
    switch (pattern.kind) {
      case "LiteralPattern":
        return runtimeEquals(pattern.value, value);
      case "IdentifierPattern":
      case "WildcardPattern":
        return true;
      case "ErrorPattern":
        return false;
    }
  }

  #objectKey(value: RuntimeValue, range: TextRange): string {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return this.#fail("SF4020", "A computed object key must be a string or finite number.", range);
  }

  #requireNumber(value: RuntimeValue, range: TextRange): number {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : this.#fail("SF4021", "Expected a finite number.", range);
  }

  #finiteNumber(value: number, range: TextRange): number {
    return Number.isFinite(value)
      ? value
      : this.#fail("SF4023", "Numeric operation produced a non-finite result.", range);
  }

  #requireBoolean(value: RuntimeValue, range: TextRange): boolean {
    return typeof value === "boolean"
      ? value
      : this.#fail("SF4022", "Expected a boolean.", range);
  }

  #fail(code: DiagnosticCode, message: string, range: TextRange): never {
    const relatedInformation: readonly RelatedDiagnosticInformation[] | undefined = this.#callStack.length === 0
      ? undefined
      : [...this.#callStack]
          .reverse()
          .map((callRange) => ({ message: "Called from here.", range: callRange }));
    throw new EvaluationFailure(diagnostic(code, "evaluate", message, range, relatedInformation));
  }
}

function normalizeGlobals(
  globals: EvaluateOptions["globals"],
): ReadonlyMap<string, RuntimeValue> {
  if (globals === undefined) {
    return new Map();
  }
  if (isReadonlyRuntimeMap(globals)) {
    return new Map(globals);
  }
  return new Map(Object.entries(globals));
}

function isReadonlyRuntimeMap(
  value: ReadonlyMap<string, RuntimeValue> | Readonly<Record<string, RuntimeValue>>,
): value is ReadonlyMap<string, RuntimeValue> {
  const iterator = (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator];
  return typeof iterator === "function";
}

function normalizeLimit(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isNativeCallable(state: object): state is { readonly kind: "native"; readonly implementation: NativeFunctionImplementation } {
  return "kind" in state && state.kind === "native";
}

function isClosureState(state: object): state is ClosureState {
  return "kind" in state && state.kind === "closure"
    && "expression" in state && "environment" in state
    && "resolution" in state && "globals" in state && "owner" in state;
}

function runtimeEquals(left: RuntimeValue, right: RuntimeValue): boolean {
  const work: Array<readonly [RuntimeValue, RuntimeValue]> = [[left, right]];
  const compared = new WeakMap<object, WeakSet<object>>();

  while (work.length > 0) {
    const pair = work.pop();
    if (pair === undefined) {
      continue;
    }
    const [leftValue, rightValue] = pair;
    if (leftValue === rightValue) {
      continue;
    }
    if (isArrayValue(leftValue) && isArrayValue(rightValue)) {
      if (alreadyCompared(leftValue, rightValue, compared)) {
        continue;
      }
      if (leftValue.elements.length !== rightValue.elements.length) {
        return false;
      }
      for (let index = 0; index < leftValue.elements.length; index += 1) {
        const leftElement = leftValue.elements[index];
        const rightElement = rightValue.elements[index];
        if (leftElement === undefined || rightElement === undefined) {
          return false;
        }
        work.push([leftElement, rightElement]);
      }
      continue;
    }
    if (isObjectValue(leftValue) && isObjectValue(rightValue)) {
      if (alreadyCompared(leftValue, rightValue, compared)) {
        continue;
      }
      if (leftValue.fields.length !== rightValue.fields.length) {
        return false;
      }
      const rightFields = new Map(rightValue.fields.map((field) => [field.key, field.value]));
      for (const field of leftValue.fields) {
        if (!rightFields.has(field.key)) {
          return false;
        }
        work.push([field.value, rightFields.get(field.key) ?? null]);
      }
      continue;
    }
    return false;
  }
  return true;
}

function alreadyCompared(
  left: object,
  right: object,
  compared: WeakMap<object, WeakSet<object>>,
): boolean {
  const rights = compared.get(left);
  if (rights?.has(right) === true) {
    return true;
  }
  if (rights === undefined) {
    compared.set(left, new WeakSet([right]));
  } else {
    rights.add(right);
  }
  return false;
}

function comparePrimitive<T extends number | string>(
  operator: "<" | "<=" | ">" | ">=",
  left: T,
  right: T,
): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}
