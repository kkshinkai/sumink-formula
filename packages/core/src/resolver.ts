import type {
  Expression,
  FnStatement,
  IdentifierExpression,
  NodeId,
  Pattern,
  Program,
  Statement,
} from "./ast.js";
import { diagnostic, sortDiagnostics, type Diagnostic, type RelatedDiagnosticInformation } from "./diagnostic.js";
import type { TextRange } from "./text.js";

declare const bindingIdBrand: unique symbol;
export type BindingId = number & { readonly [bindingIdBrand]: true };

export type ResolvedReference =
  | { readonly kind: "local"; readonly bindingId: BindingId }
  | {
      readonly kind: "external";
      readonly name: string;
      readonly displayName: string;
      readonly dependencyName?: string;
    };

export interface ExternalBindingResolution {
  readonly runtimeName: string;
  readonly displayName: string;
  readonly dependencyName?: string;
}

export type ResolvedModuleMember =
  | { readonly kind: "value"; readonly binding: ExternalBindingResolution }
  | { readonly kind: "module"; readonly module: ResolvedModuleBinding };

export interface ResolvedModuleBinding {
  readonly displayName: string;
  readonly exports: ReadonlyMap<string, ResolvedModuleMember>;
}

export interface Resolution {
  readonly references: ReadonlyMap<NodeId, ResolvedReference>;
  readonly bindings: ReadonlyMap<NodeId, BindingId>;
  readonly dependencies: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResolveOptions {
  /** When present, free identifiers must be declared by this host binding set. */
  readonly externalBindings?: ReadonlySet<string>;
  readonly importedValues?: ReadonlyMap<string, ExternalBindingResolution>;
  readonly importedModules?: ReadonlyMap<string, ResolvedModuleBinding>;
}

export function resolve(program: Program, options: ResolveOptions = {}): Resolution {
  return new Resolver(options).resolve(program);
}

export function resolveExpression(
  expression: Expression,
  options: ResolveOptions = {},
): Resolution {
  return new Resolver(options).resolveExpression(expression);
}

type ScopeSymbol =
  | { readonly kind: "local"; readonly bindingId: BindingId }
  | { readonly kind: "external"; readonly binding: ExternalBindingResolution }
  | { readonly kind: "module"; readonly module: ResolvedModuleBinding };

class Scope {
  readonly #parent: Scope | undefined;
  readonly #bindings = new Map<string, BindingId>();
  readonly #importedValues: ReadonlyMap<string, ExternalBindingResolution>;
  readonly #importedModules: ReadonlyMap<string, ResolvedModuleBinding>;

  public constructor(
    parent?: Scope,
    importedValues: ReadonlyMap<string, ExternalBindingResolution> = new Map(),
    importedModules: ReadonlyMap<string, ResolvedModuleBinding> = new Map(),
  ) {
    this.#parent = parent;
    this.#importedValues = importedValues;
    this.#importedModules = importedModules;
  }

  public declare(name: string, bindingId: BindingId): boolean {
    if (this.#bindings.has(name)) {
      return false;
    }
    this.#bindings.set(name, bindingId);
    return true;
  }

  public lookup(name: string): ScopeSymbol | undefined {
    const local = this.#bindings.get(name);
    if (local !== undefined) {
      return { kind: "local", bindingId: local };
    }
    const importedValue = this.#importedValues.get(name);
    if (importedValue !== undefined) {
      return { kind: "external", binding: importedValue };
    }
    const importedModule = this.#importedModules.get(name);
    if (importedModule !== undefined) {
      return { kind: "module", module: importedModule };
    }
    return this.#parent?.lookup(name);
  }
}

interface BindingDeclaration {
  readonly name: string;
  readonly range: TextRange;
}

class Resolver {
  readonly #references = new Map<NodeId, ResolvedReference>();
  readonly #bindings = new Map<NodeId, BindingId>();
  readonly #bindingDeclarations = new Map<BindingId, BindingDeclaration>();
  readonly #dependencies = new Set<string>();
  readonly #diagnostics: Diagnostic[] = [];
  #nextBindingId = 0;

  readonly #externalBindings: ReadonlySet<string> | undefined;
  readonly #importedValues: ReadonlyMap<string, ExternalBindingResolution>;
  readonly #importedModules: ReadonlyMap<string, ResolvedModuleBinding>;

  public constructor(options: ResolveOptions) {
    this.#externalBindings = options.externalBindings === undefined
      ? undefined
      : new Set(options.externalBindings);
    this.#importedValues = options.importedValues ?? new Map();
    this.#importedModules = options.importedModules ?? new Map();
  }

  public resolve(program: Program): Resolution {
    const statements = program.items.filter(isStatement);
    this.#statementList(
      statements,
      new Scope(undefined, this.#importedValues, this.#importedModules),
    );
    return this.#result();
  }

  public resolveExpression(expression: Expression): Resolution {
    this.#expression(
      expression,
      new Scope(undefined, this.#importedValues, this.#importedModules),
    );
    return this.#result();
  }

  #result(): Resolution {
    return {
      references: this.#references,
      bindings: this.#bindings,
      dependencies: this.#dependencies,
      diagnostics: sortDiagnostics(this.#diagnostics),
    };
  }

  #statementList(statements: readonly Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind === "FnStatement") {
        this.#declareFunction(statement, scope);
      }
    }

    for (const statement of statements) {
      switch (statement.kind) {
        case "LetStatement":
          this.#expression(statement.value, scope);
          this.#declarePattern(statement.pattern, scope);
          break;
        case "FnStatement": {
          const functionScope = new Scope(scope);
          statement.parameters.forEach((parameter) => this.#declarePattern(parameter, functionScope));
          this.#expression(statement.body, functionScope);
          break;
        }
        case "ExpressionStatement":
          this.#expression(statement.expression, scope);
          break;
      }
    }
  }

  #expression(expression: Expression, scope: Scope): void {
    switch (expression.kind) {
      case "ErrorExpression":
      case "LiteralExpression":
        return;
      case "IdentifierExpression":
        this.#reference(expression, scope);
        return;
      case "ArrayExpression":
        expression.elements.forEach((element) => this.#expression(element, scope));
        return;
      case "DictionaryExpression":
        for (const entry of expression.entries) {
          this.#expression(entry.key, scope);
          this.#expression(entry.value, scope);
        }
        return;
      case "CallExpression":
        this.#expression(expression.callee, scope);
        expression.arguments.forEach((argument) => this.#expression(argument, scope));
        return;
      case "GroupedExpression":
        this.#expression(expression.expression, scope);
        return;
      case "ClosureExpression": {
        const closureScope = new Scope(scope);
        expression.parameters.forEach((parameter) => this.#declarePattern(parameter, closureScope));
        this.#expression(expression.body, closureScope);
        return;
      }
      case "BlockExpression": {
        const blockScope = new Scope(scope);
        this.#statementList(expression.statements, blockScope);
        if (expression.result !== undefined) {
          this.#expression(expression.result, blockScope);
        }
        return;
      }
      case "IfExpression":
        this.#expression(expression.condition, scope);
        this.#expression(expression.consequent, scope);
        if (expression.alternative !== undefined) {
          this.#expression(expression.alternative, scope);
        }
        return;
      case "PrefixOperatorExpression":
        this.#expression(expression.operand, scope);
        return;
      case "InfixOperatorExpression":
        this.#expression(expression.left, scope);
        this.#expression(expression.right, scope);
        return;
      case "FieldSelectorExpression":
        if (this.#qualifiedModuleReference(expression, scope)) {
          return;
        }
        this.#expression(expression.receiver, scope);
        return;
      case "ComputedSelectorExpression":
        this.#expression(expression.receiver, scope);
        this.#expression(expression.selector, scope);
        return;
      case "MatchTestExpression":
        this.#expression(expression.subject, scope);
        return;
      case "MatchSelectionExpression":
        this.#expression(expression.subject, scope);
        for (const arm of expression.arms) {
          const armScope = new Scope(scope);
          this.#declarePattern(arm.pattern, armScope);
          this.#expression(arm.result, armScope);
        }
        return;
    }
  }

  #reference(identifier: IdentifierExpression, scope: Scope): void {
    const symbol = scope.lookup(identifier.name);
    if (symbol === undefined) {
      this.#references.set(identifier.id, {
        kind: "external",
        name: identifier.name,
        displayName: identifier.name,
        dependencyName: identifier.name,
      });
      this.#dependencies.add(identifier.name);
      if (
        this.#externalBindings !== undefined
        && !this.#externalBindings.has(identifier.name)
      ) {
        this.#diagnostics.push(diagnostic(
          "SF3001",
          "resolve",
          `Cannot find binding '${identifier.name}' in the host environment.`,
          identifier.range,
        ));
      }
      return;
    }
    if (symbol.kind === "local") {
      this.#references.set(identifier.id, { kind: "local", bindingId: symbol.bindingId });
      return;
    }
    if (symbol.kind === "external") {
      this.#references.set(identifier.id, {
        kind: "external",
        name: symbol.binding.runtimeName,
        displayName: symbol.binding.displayName,
        ...(symbol.binding.dependencyName === undefined
          ? {}
          : { dependencyName: symbol.binding.dependencyName }),
      });
      if (symbol.binding.dependencyName !== undefined) {
        this.#dependencies.add(symbol.binding.dependencyName);
      }
      return;
    }
    this.#diagnostics.push(diagnostic(
      "SF3001",
      "resolve",
      `Module '${identifier.name}' cannot be used as a runtime value.`,
      identifier.range,
    ));
  }

  #qualifiedModuleReference(
    expression: Extract<Expression, { readonly kind: "FieldSelectorExpression" }>,
    scope: Scope,
  ): boolean {
    const path = qualifiedFieldPath(expression);
    if (path === undefined) {
      return false;
    }
    const root = scope.lookup(path.root.name);
    if (root?.kind !== "module") {
      return false;
    }

    let module = root.module;
    for (let index = 0; index < path.fields.length; index += 1) {
      const field = path.fields[index];
      if (field === undefined) {
        return true;
      }
      const member = module.exports.get(field.name);
      if (member === undefined) {
        this.#diagnostics.push(diagnostic(
          "SF3001",
          "resolve",
          `Module '${module.displayName}' has no export named '${field.name}'.`,
          field.range,
        ));
        return true;
      }
      const isLast = index === path.fields.length - 1;
      if (member.kind === "module") {
        if (isLast) {
          this.#diagnostics.push(diagnostic(
            "SF3001",
            "resolve",
            `Module '${field.name}' cannot be used as a runtime value.`,
            field.range,
          ));
          return true;
        }
        module = member.module;
        continue;
      }
      if (!isLast) {
        this.#diagnostics.push(diagnostic(
          "SF3001",
          "resolve",
          `Export '${field.name}' is a value, not a module.`,
          field.range,
        ));
        return true;
      }
      this.#references.set(expression.id, {
        kind: "external",
        name: member.binding.runtimeName,
        displayName: member.binding.displayName,
        ...(member.binding.dependencyName === undefined
          ? {}
          : { dependencyName: member.binding.dependencyName }),
      });
      if (member.binding.dependencyName !== undefined) {
        this.#dependencies.add(member.binding.dependencyName);
      }
      return true;
    }
    return true;
  }

  #declareFunction(statement: FnStatement, scope: Scope): void {
    this.#declare(statement.id, statement.name, statement.nameRange, scope);
  }

  #declarePattern(pattern: Pattern, scope: Scope): void {
    if (pattern.kind === "IdentifierPattern") {
      this.#declare(pattern.id, pattern.name, pattern.range, scope);
    }
  }

  #declare(nodeId: NodeId, name: string, range: TextRange, scope: Scope): void {
    const bindingId = this.#newBindingId();
    if (!scope.declare(name, bindingId)) {
      const previousSymbol = scope.lookup(name);
      const previous = previousSymbol?.kind !== "local"
        ? undefined
        : this.#bindingDeclarations.get(previousSymbol.bindingId);
      const relatedInformation: readonly RelatedDiagnosticInformation[] | undefined = previous === undefined
        ? undefined
        : [{ message: "The first binding is here.", range: previous.range }];
      this.#diagnostics.push(diagnostic(
        "SF3000",
        "resolve",
        `Duplicate binding '${name}' in the same lexical scope.`,
        range,
        relatedInformation,
      ));
      return;
    }

    this.#bindings.set(nodeId, bindingId);
    this.#bindingDeclarations.set(bindingId, { name, range });
  }

  #newBindingId(): BindingId {
    const id = this.#nextBindingId;
    this.#nextBindingId += 1;
    return id as BindingId;
  }
}

function isStatement(item: Program["items"][number]): item is Statement {
  return item.kind === "LetStatement"
    || item.kind === "FnStatement"
    || item.kind === "ExpressionStatement";
}

function qualifiedFieldPath(
  expression: Extract<Expression, { readonly kind: "FieldSelectorExpression" }>,
): {
  readonly root: IdentifierExpression;
  readonly fields: readonly { readonly name: string; readonly range: TextRange }[];
} | undefined {
  const fields: { name: string; range: TextRange }[] = [];
  let current: Expression = expression;
  while (current.kind === "FieldSelectorExpression") {
    fields.unshift({ name: current.field, range: current.fieldRange });
    current = current.receiver;
  }
  return current.kind === "IdentifierExpression" ? { root: current, fields } : undefined;
}
