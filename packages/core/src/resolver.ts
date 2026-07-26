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

  public resolve(program: Program): Resolution {
    this.#statementList(program.statements, new Scope());
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
      const previousBindingId = scope.lookup(name);
      const previous = previousBindingId === undefined
        ? undefined
        : this.#bindingDeclarations.get(previousBindingId);
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
