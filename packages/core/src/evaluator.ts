import type {
  ClosureExpression,
  Expression,
  FnStatement,
  InfixOperator,
  MatchSelectionExpression,
  NodeId,
  Pattern,
  PrefixOperator,
  Program,
  Statement,
} from "./ast.js";
import {
  diagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type RelatedDiagnosticInformation,
} from "./diagnostic.js";
import type { BindingId, Resolution, ResolvedReference } from "./resolver.js";
import {
  arrayValue,
  callableState,
  dictionaryValue,
  getDictionaryEntry,
  isArrayValue,
  isDictionaryValue,
  isFunctionValue,
  isRuntimeValue,
  registerClosure,
  runtimeEquals,
  type FunctionValue,
  type NativeFunctionImplementation,
  type RuntimeDictionaryEntry,
  type RuntimeValue,
} from "./runtime-value.js";
import type { TextRange } from "./text.js";

export interface EvaluateOptions {
  readonly globals?: ReadonlyMap<string, RuntimeValue> | Readonly<Record<string, RuntimeValue>>;
  /** Maximum number of expression evaluations. Defaults to 100,000. */
  readonly maxSteps?: number;
  /** Maximum nested formula call depth. Defaults to 512. */
  readonly maxCallDepth?: number;
  /** @internal Shared by all evaluators in one linked module graph. */
  readonly dependencySink?: Set<string>;
  /** @internal Source identity used for cross-module diagnostics. */
  readonly sourceName?: string;
}

export type EvaluationResult =
  | { readonly ok: true; readonly value: RuntimeValue; readonly usedDependencies: ReadonlySet<string> }
  | { readonly ok: false; readonly diagnostic: Diagnostic; readonly usedDependencies: ReadonlySet<string> };

export type ModuleEvaluationResult =
  | {
      readonly ok: true;
      readonly exports: ReadonlyMap<string, RuntimeValue>;
      readonly usedDependencies: ReadonlySet<string>;
    }
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
    options.dependencySink,
    options.sourceName,
  ).evaluateProgram(program);
}

export function evaluateExpression(
  expression: Expression,
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
    options.dependencySink,
    options.sourceName,
  ).evaluateExpression(expression);
}

export function evaluateModule(
  statements: readonly Statement[],
  resolution: Resolution,
  exportedBindings: ReadonlyMap<string, BindingId>,
  options: EvaluateOptions = {},
): ModuleEvaluationResult {
  const existingDiagnostic = resolution.diagnostics.find((entry) => entry.category === "error");
  if (existingDiagnostic !== undefined) {
    return { ok: false, diagnostic: existingDiagnostic, usedDependencies: new Set() };
  }
  return new Evaluator(
    resolution,
    normalizeGlobals(options.globals),
    normalizeLimit(options.maxSteps, 100_000, "maxSteps"),
    normalizeLimit(options.maxCallDepth, 512, "maxCallDepth"),
    options.dependencySink,
    options.sourceName,
  ).evaluateModule(statements, exportedBindings);
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
  readonly #slots: Map<BindingId, Slot>;

  public constructor(parent?: Environment, slots: Map<BindingId, Slot> = new Map()) {
    this.#parent = parent;
    this.#slots = slots;
  }

  public define(bindingId: BindingId): Slot {
    if (this.#slots.has(bindingId)) {
      throw new Error("A runtime slot cannot be defined twice in one environment.");
    }
    const slot = new Slot();
    this.#slots.set(bindingId, slot);
    return slot;
  }

  public slot(bindingId: BindingId): Slot | undefined {
    return this.#slots.get(bindingId) ?? this.#parent?.slot(bindingId);
  }
}

interface ClosureState {
  readonly kind: "closure";
  readonly parameters: readonly Pattern[];
  readonly body: Expression;
  readonly environment: Environment;
  readonly resolution: Resolution;
  readonly globals: ReadonlyMap<string, RuntimeValue>;
  readonly owner: object;
  readonly dependencySink: Set<string>;
  readonly sourceName?: string;
}

interface CallFrame {
  readonly range: TextRange;
  readonly sourceName?: string;
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
  readonly #callStack: CallFrame[] = [];
  readonly #usedDependencies: Set<string>;
  readonly #maxSteps: number;
  readonly #maxCallDepth: number;
  readonly #evaluationOwner = Object.freeze({});
  #activeOwner: object;
  #trackExternalDependencies = true;
  #sourceName: string | undefined;
  #steps = 0;

  public constructor(
    resolution: Resolution,
    globals: ReadonlyMap<string, RuntimeValue>,
    maxSteps: number,
    maxCallDepth: number,
    dependencySink?: Set<string>,
    sourceName?: string,
  ) {
    this.#resolution = resolution;
    this.#globals = globals;
    this.#maxSteps = maxSteps;
    this.#maxCallDepth = maxCallDepth;
    this.#usedDependencies = dependencySink ?? new Set();
    this.#sourceName = sourceName;
    this.#activeOwner = this.#evaluationOwner;
  }

  public evaluateProgram(program: Program): EvaluationResult {
    return this.#run(
      program.range,
      () => this.#scope(program.items.filter(isStatement)),
    );
  }

  public evaluateExpression(expression: Expression): EvaluationResult {
    return this.#run(expression.range, () => this.#expression(expression, new Environment()));
  }

  public evaluateModule(
    statements: readonly Statement[],
    exportedBindings: ReadonlyMap<string, BindingId>,
  ): ModuleEvaluationResult {
    const range: TextRange = statements.length === 0
      ? { start: 0, end: 0 }
      : {
          start: statements[0]?.range.start ?? 0,
          end: statements.at(-1)?.range.end ?? 0,
        };
    try {
      const environment = this.#executeScope(statements);
      const exports = new Map<string, RuntimeValue>();
      for (const [name, bindingId] of exportedBindings) {
        const slot = environment.slot(bindingId);
        if (slot === undefined) {
          this.#fail("SF4004", `Export '${name}' has no runtime slot.`, range);
        }
        if (!slot.initialized) {
          this.#fail("SF4005", `Export '${name}' was read before initialization.`, range);
        }
        exports.set(name, slot.read());
      }
      return { ok: true, exports, usedDependencies: this.#usedDependencies };
    } catch (error: unknown) {
      if (error instanceof EvaluationFailure) {
        return { ok: false, diagnostic: error.diagnostic, usedDependencies: this.#usedDependencies };
      }
      return {
        ok: false,
        diagnostic: this.#diagnostic("SF4999", "Internal evaluator failure.", range),
        usedDependencies: this.#usedDependencies,
      };
    }
  }

  #run(range: TextRange, action: () => RuntimeValue): EvaluationResult {
    try {
      return { ok: true, value: action(), usedDependencies: this.#usedDependencies };
    } catch (error: unknown) {
      if (error instanceof EvaluationFailure) {
        return { ok: false, diagnostic: error.diagnostic, usedDependencies: this.#usedDependencies };
      }
      return {
        ok: false,
        diagnostic: this.#diagnostic("SF4999", "Internal evaluator failure.", range),
        usedDependencies: this.#usedDependencies,
      };
    }
  }

  #scope(
    statements: readonly Statement[],
    parent?: Environment,
    result?: Expression,
  ): RuntimeValue {
    const environment = this.#executeScope(statements, parent);
    return result === undefined ? null : this.#expression(result, environment);
  }

  #executeScope(statements: readonly Statement[], parent?: Environment): Environment {
    const environment = new Environment(parent);

    for (const statement of statements) {
      if (statement.kind === "FnStatement") {
        this.#allocateBinding(statement.id, environment);
      } else if (statement.kind === "LetStatement") {
        this.#allocatePattern(statement.pattern, environment);
      }
    }
    for (const statement of statements) {
      if (statement.kind === "FnStatement") {
        this.#initializeFunction(statement, environment);
      }
    }

    for (const statement of statements) {
      this.#statement(statement, environment);
    }
    return environment;
  }

  #statement(statement: Statement, environment: Environment): void {
    switch (statement.kind) {
      case "LetStatement": {
        const value = this.#expression(statement.value, environment);
        if (!this.#matchAndBind(statement.pattern, value, environment)) {
          this.#fail("SF4007", "Let binding pattern did not match its value.", statement.pattern.range);
        }
        return;
      }
      case "FnStatement":
        return;
      case "ExpressionStatement":
        this.#expression(statement.expression, environment);
        return;
    }
  }

  #initializeFunction(statement: FnStatement, environment: Environment): void {
    const bindingId = this.#resolution.bindings.get(statement.id);
    const slot = bindingId === undefined ? undefined : environment.slot(bindingId);
    if (slot === undefined) {
      this.#fail("SF4004", "Resolved function binding has no runtime slot.", statement.nameRange);
    }
    slot.initialize(this.#closureValue(
      statement.parameters,
      statement.body,
      environment,
      statement.name,
    ));
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
        return this.#readReference(reference, environment, expression.range);
      }
      case "ArrayExpression":
        return arrayValue(expression.elements.map((element) => this.#expression(element, environment)));
      case "DictionaryExpression": {
        const entries: RuntimeDictionaryEntry[] = [];
        for (const entry of expression.entries) {
          const key = this.#expression(entry.key, environment);
          entries.push({ key, value: this.#expression(entry.value, environment) });
        }
        return dictionaryValue(entries);
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
      case "BlockExpression":
        return this.#scope(expression.statements, environment, expression.result);
      case "IfExpression": {
        const condition = this.#requireBoolean(
          this.#expression(expression.condition, environment),
          expression.condition.range,
        );
        if (condition) {
          return this.#expression(expression.consequent, environment);
        }
        return expression.alternative === undefined
          ? null
          : this.#expression(expression.alternative, environment);
      }
      case "PrefixOperatorExpression":
        return this.#prefix(
          expression.operator,
          this.#expression(expression.operand, environment),
          expression.range,
        );
      case "InfixOperatorExpression":
        return this.#infix(expression.operator, expression.left, expression.right, environment, expression.range);
      case "FieldSelectorExpression": {
        const reference = this.#resolution.references.get(expression.id);
        if (reference !== undefined) {
          return this.#readReference(reference, environment, expression.range);
        }
        const receiver = this.#expression(expression.receiver, environment);
        if (!isDictionaryValue(receiver)) {
          return this.#fail("SF4006", "Field selection requires a dictionary value.", expression.receiver.range);
        }
        return getDictionaryEntry(receiver, expression.field) ?? null;
      }
      case "ComputedSelectorExpression":
        return this.#select(
          this.#expression(expression.receiver, environment),
          this.#expression(expression.selector, environment),
          expression.range,
        );
      case "MatchTestExpression": {
        const subject = this.#expression(expression.subject, environment);
        return this.#matches(expression.pattern, subject);
      }
      case "MatchSelectionExpression":
        return this.#matchSelection(expression, environment);
    }
  }

  #readReference(
    reference: ResolvedReference,
    environment: Environment,
    range: TextRange,
  ): RuntimeValue {
    if (reference.kind === "external") {
      if (this.#trackExternalDependencies && reference.dependencyName !== undefined) {
        this.#usedDependencies.add(reference.dependencyName);
      }
      if (!this.#globals.has(reference.name)) {
        return this.#fail(
          "SF4003",
          `No value was provided for external binding '${reference.displayName}'.`,
          range,
        );
      }
      const value: unknown = this.#globals.get(reference.name);
      if (!isRuntimeValue(value)) {
        return this.#fail(
          "SF4026",
          `External binding '${reference.displayName}' is not a valid immutable runtime value.`,
          range,
        );
      }
      return value;
    }

    const slot = environment.slot(reference.bindingId);
    if (slot === undefined) {
      return this.#fail("SF4004", "Resolved lexical binding has no runtime slot.", range);
    }
    if (!slot.initialized) {
      return this.#fail("SF4005", "A lexical binding was read before it was initialized.", range);
    }
    return slot.read();
  }

  #closure(expression: ClosureExpression, environment: Environment): FunctionValue {
    return this.#closureValue(expression.parameters, expression.body, environment);
  }

  #closureValue(
    parameters: readonly Pattern[],
    body: Expression,
    environment: Environment,
    name?: string,
  ): FunctionValue {
    const value: FunctionValue = Object.freeze({
      kind: "function",
      ...(name === undefined ? {} : { name }),
      arity: parameters.length,
    });
    registerClosure(value, Object.freeze({
      kind: "closure",
      parameters,
      body,
      environment,
      resolution: this.#resolution,
      globals: this.#globals,
      owner: this.#activeOwner,
      dependencySink: this.#usedDependencies,
      ...(this.#sourceName === undefined ? {} : { sourceName: this.#sourceName }),
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

    this.#callStack.push({
      range,
      ...(this.#sourceName === undefined ? {} : { sourceName: this.#sourceName }),
    });
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
      const previousSourceName = this.#sourceName;
      this.#resolution = closure.resolution;
      this.#globals = closure.globals;
      this.#activeOwner = closure.owner;
      this.#trackExternalDependencies = closure.dependencySink === this.#usedDependencies;
      this.#sourceName = closure.sourceName;
      try {
        const slots = new Map<BindingId, Slot>();
        closure.parameters.forEach((parameter) => this.#allocatePatternInto(parameter, slots));
        const callEnvironment = new Environment(closure.environment, slots);
        for (let index = 0; index < closure.parameters.length; index += 1) {
          const parameter = closure.parameters[index];
          if (parameter === undefined || !this.#matchAndBind(parameter, arguments_[index] ?? null, callEnvironment)) {
            return this.#fail("SF4011", `Argument ${index + 1} did not match its parameter pattern.`, range);
          }
        }
        return this.#expression(closure.body, callEnvironment);
      } finally {
        this.#resolution = previousResolution;
        this.#globals = previousGlobals;
        this.#activeOwner = previousOwner;
        this.#trackExternalDependencies = previousTracking;
        this.#sourceName = previousSourceName;
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
    if (isDictionaryValue(receiver)) {
      return getDictionaryEntry(receiver, selector) ?? null;
    }
    return this.#fail("SF4018", "Computed selection requires an array or dictionary value.", range);
  }

  #matchSelection(expression: MatchSelectionExpression, environment: Environment): RuntimeValue {
    const subject = this.#expression(expression.subject, environment);
    for (const arm of expression.arms) {
      const slots = new Map<BindingId, Slot>();
      this.#allocatePatternInto(arm.pattern, slots);
      const armEnvironment = new Environment(environment, slots);
      if (this.#matchAndBind(arm.pattern, subject, armEnvironment)) {
        return this.#expression(arm.result, armEnvironment);
      }
    }
    return this.#fail("SF4019", "No match arm accepted the value.", expression.range);
  }

  #allocateBinding(nodeId: NodeId, environment: Environment): void {
    const bindingId = this.#resolution.bindings.get(nodeId);
    if (bindingId !== undefined) {
      environment.define(bindingId);
    }
  }

  #allocatePattern(pattern: Pattern, environment: Environment): void {
    if (pattern.kind !== "IdentifierPattern") {
      return;
    }
    const bindingId = this.#resolution.bindings.get(pattern.id);
    if (bindingId !== undefined) {
      environment.define(bindingId);
    }
  }

  #allocatePatternInto(pattern: Pattern, slots: Map<BindingId, Slot>): void {
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
          .map((call) => ({
            message: "Called from here.",
            range: call.range,
            ...(call.sourceName === undefined ? {} : { sourceName: call.sourceName }),
          }));
    throw new EvaluationFailure(this.#diagnostic(code, message, range, relatedInformation));
  }

  #diagnostic(
    code: DiagnosticCode,
    message: string,
    range: TextRange,
    relatedInformation?: readonly RelatedDiagnosticInformation[],
  ): Diagnostic {
    const value = diagnostic(code, "evaluate", message, range, relatedInformation);
    return this.#sourceName === undefined ? value : { ...value, sourceName: this.#sourceName };
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
    && "parameters" in state && "body" in state && "environment" in state
    && "resolution" in state && "globals" in state && "owner" in state
    && "dependencySink" in state;
}

function isStatement(item: Program["items"][number]): item is Statement {
  return item.kind === "LetStatement"
    || item.kind === "FnStatement"
    || item.kind === "ExpressionStatement";
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
