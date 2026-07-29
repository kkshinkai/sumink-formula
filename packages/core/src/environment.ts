import type { Diagnostic } from "./diagnostic.js";
import {
  evaluateExpression,
  type EvaluationResult,
} from "./evaluator.js";
import {
  analyzeExpression,
  type ExpressionAnalysisResult,
} from "./interpreter.js";
import { lex } from "./lexer.js";
import {
  compileLinkedProgram,
  type LinkedProgram,
  type LinkedProgramAnalysis,
  type ProgramCompileOptions,
} from "./module-system.js";
import type {
  ExternalBindingResolution,
  ResolvedModuleBinding,
  ResolvedModuleMember,
} from "./resolver.js";
import {
  isRuntimeValue,
  nativeFunction,
  type NativeFunctionImplementation,
  type RuntimeValue,
} from "./runtime-value.js";
import { SyntaxKind } from "./syntax-kind.js";
import type { SourceText } from "./text.js";

const bindingDefinitionBrand = Symbol("SumiEnvironmentBinding");
const bindingDefinitions = new WeakSet<object>();
const activationStates = new WeakMap<object, ActivationState>();

declare const activationTypeBrand: unique symbol;

export interface ExternalValueBinding {
  readonly kind: "external-value";
  readonly [bindingDefinitionBrand]: true;
}

export interface ConstantValueBinding {
  readonly kind: "constant-value";
  readonly value: RuntimeValue;
  readonly [bindingDefinitionBrand]: true;
}

export interface HostFunctionBinding {
  readonly kind: "host-function";
  readonly parameters: readonly string[];
  readonly invoke: NativeFunctionImplementation;
  readonly [bindingDefinitionBrand]: true;
}

export interface NativeModuleBinding<
  TDefinition extends EnvironmentDefinition = EnvironmentDefinition,
> {
  readonly kind: "native-module";
  readonly definition: TDefinition;
  readonly [bindingDefinitionBrand]: true;
}

export type EnvironmentBinding =
  | ExternalValueBinding
  | ConstantValueBinding
  | HostFunctionBinding
  | NativeModuleBinding;

export type EnvironmentDefinition = Readonly<Record<string, EnvironmentBinding>>;

export type ActivationValues<TDefinition extends EnvironmentDefinition> = {
  readonly [TName in keyof TDefinition as TDefinition[TName] extends
    ExternalValueBinding | NativeModuleBinding ? TName : never]?:
      TDefinition[TName] extends ExternalValueBinding
        ? RuntimeValue
        : TDefinition[TName] extends NativeModuleBinding<infer TModule>
          ? ActivationValues<TModule>
          : never;
};

export interface Activation<TDefinition extends EnvironmentDefinition = EnvironmentDefinition> {
  /** @internal Keeps activations from unrelated environments distinct in TypeScript. */
  readonly [activationTypeBrand]: (definition: TDefinition) => TDefinition;
}

export interface PreparedEvaluationOptions {
  /** Maximum number of expression evaluations. Defaults to 100,000. */
  readonly maxSteps?: number;
  /** Maximum nested formula call depth. Defaults to 512. */
  readonly maxCallDepth?: number;
}

interface PreparedUnit<TDefinition extends EnvironmentDefinition> {
  /** All free names, including constants and host functions. */
  readonly freeNames: readonly string[];
  /** Free names whose values are supplied by each activation. */
  readonly dependencies: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  evaluate(
    activation: Activation<TDefinition>,
    options?: PreparedEvaluationOptions,
  ): EvaluationResult;
}

export interface PreparedExpression<TDefinition extends EnvironmentDefinition = EnvironmentDefinition>
  extends PreparedUnit<TDefinition> {
  readonly kind: "expression";
  readonly analysis: ExpressionAnalysisResult;
}

export interface PreparedProgram<TDefinition extends EnvironmentDefinition = EnvironmentDefinition>
  extends PreparedUnit<TDefinition> {
  readonly kind: "program";
  readonly analysis: LinkedProgramAnalysis;
}

export type Compilation<TProgram> =
  | {
      readonly ok: true;
      readonly program: TProgram;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly sources?: ReadonlyMap<string, SourceText>;
    };

export interface SumiEnvironment<TDefinition extends EnvironmentDefinition = EnvironmentDefinition> {
  compileExpression(source: string): Compilation<PreparedExpression<TDefinition>>;
  compileProgram(
    source: string,
    options?: ProgramCompileOptions,
  ): Compilation<PreparedProgram<TDefinition>>;
  createActivation(values: ActivationValues<TDefinition>): Activation<TDefinition>;
}

interface NormalizedInputBinding {
  readonly kind: "input";
}

interface NormalizedConstantBinding {
  readonly kind: "constant";
  readonly value: RuntimeValue;
}

type NormalizedBinding = NormalizedInputBinding | NormalizedConstantBinding;

interface ActivationState {
  readonly environment: object;
  readonly values: ReadonlyMap<string, RuntimeValue>;
}

export function externalValue(): ExternalValueBinding {
  const definition = Object.freeze({
    kind: "external-value" as const,
    [bindingDefinitionBrand]: true as const,
  });
  bindingDefinitions.add(definition);
  return definition;
}

export function constantValue(value: RuntimeValue): ConstantValueBinding {
  if (!isRuntimeValue(value)) {
    throw new TypeError("An environment constant must be an immutable Sumi runtime value.");
  }
  const definition = Object.freeze({
    kind: "constant-value" as const,
    value,
    [bindingDefinitionBrand]: true as const,
  });
  bindingDefinitions.add(definition);
  return definition;
}

export function hostFunction(options: {
  readonly parameters: readonly string[];
  readonly invoke: NativeFunctionImplementation;
}): HostFunctionBinding {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("A host function definition must be an object.");
  }
  if (!Array.isArray(options.parameters)) {
    throw new TypeError("Host function parameters must be an array.");
  }
  if (typeof options.invoke !== "function") {
    throw new TypeError("A host function implementation must be callable.");
  }

  const parameters = [...options.parameters];
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (typeof parameter !== "string") {
      throw new TypeError("Every host function parameter must be a Sumi identifier.");
    }
    if (!isSumiIdentifier(parameter)) {
      throw new TypeError(`Host function parameter '${parameter}' is not a Sumi identifier.`);
    }
    if (names.has(parameter)) {
      throw new TypeError(`Host function parameter '${parameter}' is duplicated.`);
    }
    names.add(parameter);
  }

  const definition = Object.freeze({
    kind: "host-function" as const,
    parameters: Object.freeze(parameters),
    invoke: options.invoke,
    [bindingDefinitionBrand]: true as const,
  });
  bindingDefinitions.add(definition);
  return definition;
}

export function nativeModule<const TDefinition extends EnvironmentDefinition>(
  definition: TDefinition,
): NativeModuleBinding<TDefinition> {
  const entries = environmentDefinitionEntries(definition, "A native module definition");
  for (const [name, binding] of entries) {
    validateEnvironmentBinding(name, binding, "Native module member");
  }
  const snapshot = Object.freeze(Object.fromEntries(entries)) as TDefinition;
  const binding = Object.freeze({
    kind: "native-module" as const,
    definition: snapshot,
    [bindingDefinitionBrand]: true as const,
  });
  bindingDefinitions.add(binding);
  return binding;
}

export function defineEnvironment<const TDefinition extends EnvironmentDefinition>(
  definition: TDefinition,
): SumiEnvironment<TDefinition> {
  return new EnvironmentImpl(definition);
}

class EnvironmentImpl<TDefinition extends EnvironmentDefinition>
implements SumiEnvironment<TDefinition> {
  readonly #identity = Object.freeze({});
  readonly #definition: TDefinition;
  readonly #bindings: ReadonlyMap<string, NormalizedBinding>;
  readonly #bindingNames: ReadonlySet<string>;
  readonly #inputNames: ReadonlySet<string>;
  readonly #constants: ReadonlyMap<string, RuntimeValue>;
  readonly #nativeModules: ReadonlyMap<string, ResolvedModuleBinding>;

  public constructor(definition: TDefinition) {
    const entries = environmentDefinitionEntries(definition, "An environment definition");
    const bindings = new Map<string, NormalizedBinding>();
    const inputNames = new Set<string>();
    const constants = new Map<string, RuntimeValue>();
    const nativeModules = new Map<string, ResolvedModuleBinding>();

    for (const [name, binding] of entries) {
      validateEnvironmentBinding(name, binding, "Environment binding");

      switch (binding.kind) {
        case "external-value":
          bindings.set(name, Object.freeze({ kind: "input" }));
          inputNames.add(name);
          break;
        case "constant-value":
          bindings.set(name, Object.freeze({ kind: "constant", value: binding.value }));
          constants.set(name, binding.value);
          break;
        case "host-function": {
          const value = nativeFunction(binding.invoke, {
            name,
            arity: binding.parameters.length,
          });
          bindings.set(name, Object.freeze({ kind: "constant", value }));
          constants.set(name, value);
          break;
        }
        case "native-module":
          nativeModules.set(
            name,
            normalizeNativeModule(binding.definition, name, inputNames, constants),
          );
          break;
      }
    }

    this.#definition = Object.freeze(Object.fromEntries(entries)) as TDefinition;
    this.#bindings = bindings;
    this.#bindingNames = new Set(bindings.keys());
    this.#inputNames = inputNames;
    this.#constants = constants;
    this.#nativeModules = nativeModules;
    Object.freeze(this);
  }

  public compileExpression(source: string): Compilation<PreparedExpression<TDefinition>> {
    if (typeof source !== "string") {
      throw new TypeError("Formula source must be a string.");
    }
    const analysis = analyzeExpression(source, { externalBindings: this.#bindingNames });
    if (hasErrors(analysis.diagnostics)) {
      return Object.freeze({ ok: false, diagnostics: analysis.diagnostics });
    }

    const program = this.#prepareExpression(analysis);
    return Object.freeze({ ok: true, program, diagnostics: analysis.diagnostics });
  }

  public compileProgram(
    source: string,
    options: ProgramCompileOptions = {},
  ): Compilation<PreparedProgram<TDefinition>> {
    if (typeof source !== "string") {
      throw new TypeError("Program source must be a string.");
    }
    const linked = compileLinkedProgram(source, {
      externalBindings: this.#bindingNames,
      nativeModules: this.#nativeModules,
      inputNames: this.#inputNames,
    }, options);
    const analysis = linked.analysis;
    if (hasErrors(analysis.diagnostics)) {
      return Object.freeze({
        ok: false,
        diagnostics: analysis.diagnostics,
        sources: analysis.sources,
      });
    }

    const program = this.#prepareProgram(linked);
    return Object.freeze({ ok: true, program, diagnostics: analysis.diagnostics });
  }

  public createActivation(values: ActivationValues<TDefinition>): Activation<TDefinition> {
    const normalized = new Map<string, RuntimeValue>();
    collectActivationValues(this.#definition, values, "", normalized);

    const activation = Object.freeze({}) as Activation<TDefinition>;
    activationStates.set(activation, Object.freeze({
      environment: this.#identity,
      values: normalized,
    }));
    return activation;
  }

  #prepareExpression(analysis: ExpressionAnalysisResult): PreparedExpression<TDefinition> {
    const common = this.#preparedFields(analysis.resolution.dependencies, analysis.diagnostics);
    return Object.freeze({
      kind: "expression" as const,
      analysis,
      ...common,
      evaluate: (
        activation: Activation<TDefinition>,
        options: PreparedEvaluationOptions = {},
      ): EvaluationResult => this.#evaluate(
        activation,
        (globals) => evaluateExpression(analysis.expression, analysis.resolution, { ...options, globals }),
      ),
    });
  }

  #prepareProgram(linked: LinkedProgram): PreparedProgram<TDefinition> {
    const analysis = linked.analysis;
    const common = this.#preparedFields(analysis.freeNames, analysis.diagnostics);
    return Object.freeze({
      kind: "program" as const,
      analysis,
      ...common,
      evaluate: (
        activation: Activation<TDefinition>,
        options: PreparedEvaluationOptions = {},
      ): EvaluationResult => this.#evaluate(
        activation,
        (globals) => linked.evaluate(globals, options),
      ),
    });
  }

  #preparedFields(
    freeNames: ReadonlySet<string>,
    diagnostics: readonly Diagnostic[],
  ): {
    readonly freeNames: readonly string[];
    readonly dependencies: readonly string[];
    readonly diagnostics: readonly Diagnostic[];
  } {
    return Object.freeze({
      freeNames: Object.freeze([...freeNames]),
      dependencies: Object.freeze([...freeNames].filter((name) => this.#inputNames.has(name))),
      diagnostics,
    });
  }

  #evaluate(
    activation: Activation<TDefinition>,
    run: (globals: ReadonlyMap<string, RuntimeValue>) => EvaluationResult,
  ): EvaluationResult {
    const state = activationStates.get(activation);
    if (state === undefined) {
      throw new TypeError("The activation was not created by a Sumi environment.");
    }
    if (state.environment !== this.#identity) {
      throw new TypeError("The activation belongs to a different Sumi environment.");
    }

    const globals = new Map(this.#constants);
    for (const [name, value] of state.values) {
      globals.set(name, value);
    }
    return filterUsedDependencies(run(globals), this.#inputNames);
  }
}

function environmentDefinitionEntries(
  definition: EnvironmentDefinition,
  subject: string,
): readonly (readonly [string, EnvironmentBinding])[] {
  validatePlainDataObject(definition, subject);
  return Object.keys(definition).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(definition, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`Environment binding '${name}' must be a data property.`);
    }
    return [name, descriptor.value] as const;
  });
}

function activationEntries(
  values: unknown,
  subject: string,
): readonly (readonly [string, unknown])[] {
  validatePlainDataObject(values, subject);
  return Object.keys(values).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(values, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`Activation value '${name}' must be a data property.`);
    }
    return [name, descriptor.value] as const;
  });
}

function validateEnvironmentBinding(
  name: string,
  binding: EnvironmentBinding,
  subject: string,
): void {
  if (!isSumiIdentifier(name)) {
    throw new TypeError(`${subject} '${name}' is not a Sumi identifier.`);
  }
  if (
    typeof binding !== "object"
    || binding === null
    || !bindingDefinitions.has(binding)
  ) {
    throw new TypeError(`${subject} '${name}' was not created by a binding constructor.`);
  }
}

function normalizeNativeModule(
  definition: EnvironmentDefinition,
  moduleName: string,
  inputNames: Set<string>,
  constants: Map<string, RuntimeValue>,
): ResolvedModuleBinding {
  const exports = new Map<string, ResolvedModuleMember>();
  for (const [name, binding] of environmentDefinitionEntries(
    definition,
    `Native module '${moduleName}'`,
  )) {
    validateEnvironmentBinding(name, binding, "Native module member");
    const qualifiedName = `${moduleName}.${name}`;
    switch (binding.kind) {
      case "external-value":
        inputNames.add(qualifiedName);
        exports.set(name, valueModuleMember(qualifiedName, qualifiedName));
        break;
      case "constant-value":
        constants.set(qualifiedName, binding.value);
        exports.set(name, valueModuleMember(qualifiedName));
        break;
      case "host-function": {
        const value = nativeFunction(binding.invoke, {
          name: qualifiedName,
          arity: binding.parameters.length,
        });
        constants.set(qualifiedName, value);
        exports.set(name, valueModuleMember(qualifiedName));
        break;
      }
      case "native-module":
        exports.set(name, {
          kind: "module",
          module: normalizeNativeModule(
            binding.definition,
            qualifiedName,
            inputNames,
            constants,
          ),
        });
        break;
    }
  }
  return Object.freeze({ displayName: moduleName, exports });
}

function valueModuleMember(
  runtimeName: string,
  dependencyName?: string,
): ResolvedModuleMember {
  const binding: ExternalBindingResolution = dependencyName === undefined
    ? { runtimeName, displayName: runtimeName }
    : { runtimeName, displayName: runtimeName, dependencyName };
  return { kind: "value", binding };
}

function collectActivationValues(
  definition: EnvironmentDefinition,
  values: unknown,
  prefix: string,
  target: Map<string, RuntimeValue>,
): void {
  const definitionMap = new Map(environmentDefinitionEntries(
    definition,
    prefix === "" ? "An environment definition" : `Native module '${prefix}'`,
  ));
  for (const [name, value] of activationEntries(
    values,
    prefix === "" ? "Activation values" : `Activation values for '${prefix}'`,
  )) {
    const qualifiedName = prefix === "" ? name : `${prefix}.${name}`;
    const binding = definitionMap.get(name);
    if (binding === undefined) {
      throw new TypeError(`Activation value '${qualifiedName}' is not declared by this environment.`);
    }
    switch (binding.kind) {
      case "external-value":
        if (!isRuntimeValue(value)) {
          throw new TypeError(
            `Activation value '${qualifiedName}' is not an immutable Sumi runtime value.`,
          );
        }
        target.set(qualifiedName, value);
        break;
      case "native-module":
        collectActivationValues(binding.definition, value, qualifiedName, target);
        break;
      case "constant-value":
      case "host-function":
        throw new TypeError(`Activation cannot replace constant binding '${qualifiedName}'.`);
    }
  }
}

function validatePlainDataObject(
  value: unknown,
  subject: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${subject} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must have a plain or null prototype.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${subject} cannot contain symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) {
      throw new TypeError(`${subject} can contain only enumerable data properties.`);
    }
  }
}

function isSumiIdentifier(value: string): boolean {
  const result = lex(value);
  const identifier = result.tokens[0];
  const eof = result.tokens[1];
  return result.diagnostics.length === 0
    && result.tokens.length === 2
    && identifier?.kind === SyntaxKind.IdentifierToken
    && identifier.range.start === 0
    && identifier.range.end === value.length
    && eof?.kind === SyntaxKind.EndOfFileToken;
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((entry) => entry.category === "error");
}

function filterUsedDependencies(
  result: EvaluationResult,
  inputNames: ReadonlySet<string>,
): EvaluationResult {
  const usedDependencies = new Set(
    [...result.usedDependencies].filter((name) => inputNames.has(name)),
  );
  return result.ok
    ? { ok: true, value: result.value, usedDependencies }
    : { ok: false, diagnostic: result.diagnostic, usedDependencies };
}
