import type {
  Expression,
  IdentifierExpression,
  IdentifierPattern,
  NodeId,
  Pattern,
  Program,
} from "./ast.js";
import { diagnostic, sortDiagnostics, type Diagnostic, type RelatedDiagnosticInformation } from "./diagnostic.js";

declare const bindingIdBrand: unique symbol;
export type BindingId = number & { readonly [bindingIdBrand]: true };

export type ResolvedReference =
  | { readonly kind: "local"; readonly bindingId: BindingId }
  | { readonly kind: "external"; readonly name: string };

export interface Resolution {
  readonly references: ReadonlyMap<NodeId, ResolvedReference>;
  readonly bindings: ReadonlyMap<NodeId, BindingId>;
  readonly dependencies: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
}

export function resolve(program: Program): Resolution {
  return new Resolver().resolve(program);
}

class Scope {
  readonly #parent: Scope | undefined;
  readonly #bindings = new Map<string, BindingId>();

  public constructor(parent?: Scope) {
    this.#parent = parent;
  }

  public declare(name: string, bindingId: BindingId): boolean {
    if (this.#bindings.has(name)) {
      return false;
    }
    this.#bindings.set(name, bindingId);
    return true;
  }

  public lookup(name: string): BindingId | undefined {
    return this.#bindings.get(name) ?? this.#parent?.lookup(name);
  }
}

class Resolver {
  readonly #references = new Map<NodeId, ResolvedReference>();
  readonly #bindings = new Map<NodeId, BindingId>();
  readonly #bindingDeclarations = new Map<BindingId, IdentifierPattern>();
  readonly #dependencies = new Set<string>();
  readonly #diagnostics: Diagnostic[] = [];
  #nextBindingId = 0;

  public resolve(program: Program): Resolution {
    const root = new Scope();
    for (const expression of program.expressions) {
      this.#expression(expression, root);
    }
    return {
      references: this.#references,
      bindings: this.#bindings,
      dependencies: this.#dependencies,
      diagnostics: sortDiagnostics(this.#diagnostics),
    };
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
      case "ObjectExpression":
        for (const member of expression.members) {
          if (member.key.kind === "ComputedObjectKey") {
            this.#expression(member.key.expression, scope);
          }
          this.#expression(member.value, scope);
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
      case "BlockExpression":
        expression.expressions.forEach((child) => this.#expression(child, scope));
        return;
      case "IfExpression":
        expression.branches.forEach((branch) => {
          this.#expression(branch.condition, scope);
          this.#expression(branch.result, scope);
        });
        this.#expression(expression.elseBranch, scope);
        return;
      case "PrefixOperatorExpression":
        this.#expression(expression.operand, scope);
        return;
      case "InfixOperatorExpression":
        this.#expression(expression.left, scope);
        this.#expression(expression.right, scope);
        return;
      case "FieldSelectorExpression":
        this.#expression(expression.receiver, scope);
        return;
      case "ComputedSelectorExpression":
        this.#expression(expression.receiver, scope);
        this.#expression(expression.selector, scope);
        return;
      case "LetExpression": {
        const letScope = new Scope(scope);
        expression.bindings.forEach((binding) => this.#declarePattern(binding.pattern, letScope));
        expression.bindings.forEach((binding) => this.#expression(binding.value, letScope));
        this.#expression(expression.body, letScope);
        return;
      }
      case "MatchTestExpression":
        this.#expression(expression.subject, scope);
        return;
      case "MatchSelectionExpression":
        this.#expression(expression.subject, scope);
        for (const matchCase of expression.cases) {
          const caseScope = new Scope(scope);
          this.#declarePattern(matchCase.pattern, caseScope);
          this.#expression(matchCase.result, caseScope);
        }
        if (expression.elseBranch !== undefined) {
          this.#expression(expression.elseBranch, scope);
        }
        return;
    }
  }

  #reference(identifier: IdentifierExpression, scope: Scope): void {
    const bindingId = scope.lookup(identifier.name);
    if (bindingId === undefined) {
      this.#references.set(identifier.id, { kind: "external", name: identifier.name });
      this.#dependencies.add(identifier.name);
    } else {
      this.#references.set(identifier.id, { kind: "local", bindingId });
    }
  }

  #declarePattern(pattern: Pattern, scope: Scope): void {
    if (pattern.kind !== "IdentifierPattern") {
      return;
    }

    const bindingId = this.#newBindingId();
    const declared = scope.declare(pattern.name, bindingId);
    if (!declared) {
      const previousBindingId = scope.lookup(pattern.name);
      const previous = previousBindingId === undefined
        ? undefined
        : this.#bindingDeclarations.get(previousBindingId);
      const relatedInformation: readonly RelatedDiagnosticInformation[] | undefined = previous === undefined
        ? undefined
        : [{ message: "The first binding is here.", range: previous.range }];
      this.#diagnostics.push(
        diagnostic(
          "SF3000",
          "resolve",
          `Duplicate binding '${pattern.name}' in the same lexical scope.`,
          pattern.range,
          relatedInformation,
        ),
      );
      return;
    }

    this.#bindings.set(pattern.id, bindingId);
    this.#bindingDeclarations.set(bindingId, pattern);
  }

  #newBindingId(): BindingId {
    const id = this.#nextBindingId;
    this.#nextBindingId += 1;
    return id as BindingId;
  }
}
