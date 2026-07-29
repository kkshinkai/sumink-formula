# `@sumink-formula/core`

The core is a handwritten front end and tree-walking interpreter for the
first-version Sumink Formula grammar.

```text
source
  -> lossless lexer token stream
  -> recovery-capable CST
  -> semantic AST
  -> lexical resolution and dependency set
  -> strict evaluator
```

The CST retains every source token and its trivia. Recovery inserts explicit
zero-width missing-token nodes without modifying the source stream. The AST is
separate so editor recovery structure cannot become executable semantics.

Trivia uses the token-ownership model of SwiftSyntax and Roslyn. Every source
character belongs to exactly one token spelling or one trivia piece. A token
owns spaces and comments after it on the same line as trailing trivia; it does
not own the following line break. That line break and subsequent trivia belong
to the next token as leading trivia. A block comment that starts on the same
line remains trailing trivia even when the comment itself spans lines. Initial
trivia belongs to the first token, and remaining file trivia belongs to the EOF
token.

This is lexical ownership only. A future documentation layer may decide that a
leading comment documents a declaration based on adjacency and comment form;
the lexer does not turn that policy into a second ownership rule.

Local identifiers are resolved to `BindingId` values before evaluation.
Unresolved lexical names are explicit host dependencies. Every lexical scope
predeclares its `fn` names and initializes them with closures over one shared
environment. `let` bindings enter scope in source order. Closures capture the
environment itself; this supports lexical shadowing, escaping closures, and
mutually recursive `fn` declarations without giving `let` recursive semantics.

Identifier classification is pinned to Unicode 16.0.0 tables rather than the
host JavaScript engine's evolving Unicode property-escape implementation.

## Engineering reference

The scanner/parser/diagnostic/binder boundaries were studied against the
official TypeScript implementation at commit
`0c2c7a358297d66df690230deaed8c98e7d77c04` (not TypeScript-Go), principally
`scanner.ts`, `parser.ts`, `types.ts`, and `binder.ts` under `src/compiler`.
Statement-list parsing and recovery also follow the boundaries documented by
the Rust Reference. Braced arguments and ordinary lambda composition were
checked against Scala 3, while missing and skipped syntax representation was
checked against Roslyn. The architecture is adapted rather than copied:
TypeScript's AST is not lossless, while this package requires a distinct
lossless CST.

Comment storage and trivia boundaries follow SwiftSyntax's token model and the
Swift parser's split between unrestricted leading trivia and same-line trailing
trivia. Roslyn's `LeadingTrivia` and `TrailingTrivia` collections provide the
same full-fidelity boundary. Documentation attachment remains a separate layer,
as it does in compilers that distinguish lexical comments from declaration
documentation.

## Public entry points

### Application embedding

`defineEnvironment` creates the immutable outer lexical scope visible to a
Program. Top-level values are ordinary Sumi identifiers. `nativeModule` creates
a statically qualified Module whose members may be values, host functions, or
further Native Modules. Local declarations and imports shadow lower-priority
host candidates through normal resolution.

```ts
import {
  constantValue,
  defineEnvironment,
  externalValue,
  hostFunction,
  nativeModule,
  runtimeValueFromJson,
} from "@sumink-formula/core";

const environment = defineEnvironment({
  app: nativeModule({
    selection: externalValue(),
    math: nativeModule({
      pi: constantValue(Math.PI),
    }),
  }),
  print: hostFunction({
    parameters: ["value"],
    invoke: ({ arguments: [value = null] }) => {
      console.log(value);
      return null;
    },
  }),
});

const compilation = environment.compileProgram(`
  import app.{selection};
  import app.math.{pi};
  print(selection.width + pi);
`);
if (!compilation.ok) {
  throw new Error(compilation.diagnostics[0]?.message ?? "Compilation failed.");
}

const activation = environment.createActivation({
  app: {
    selection: runtimeValueFromJson({ width: 320, height: 180 }),
  },
});
const result = compilation.program.evaluate(activation);
```

`compileExpression` accepts one standalone expression and returns its value.
`compileProgram` accepts the executable Program root used by entry `.sumi`
files, links nested, Native, and loaded File Modules, and returns `nil` after
execution. Both produce reusable prepared units whose
`freeNames` list includes every host binding they mention. `dependencies`
contains only names declared with `externalValue`; constants and host functions
do not cause reactive invalidation. A Native dependency uses its stable fully
qualified name, such as `app.selection`, even when imported under another name.
Standalone expressions have no import declarations; Native Modules are
available to Programs through explicit imports.

An activation is an immutable snapshot of the changing values for one
evaluation. Its shape recursively mirrors Native Modules. It can be partial: an
absent value becomes a language error only if execution reads it. An activation
cannot override constants, introduce new names, or be used with a formula
compiled by another environment.

File Module loading is explicit host policy:

```ts
const compilation = environment.compileProgram(source, {
  sourceName: entryName,
  fileModuleLoader: {
    load(specifier, referrer) {
      return {
        ok: true,
        source: resolveAndRead(specifier, referrer),
      };
    },
  },
});
```

The loader returns `{ name, text }`; `name` is the canonical identity used for
caching, cycle detection, and diagnostics. Core treats `specifier` as opaque.
It does not implement filesystem, extension, Project, or package resolution.

`runtimeValueFromJson` copies JSON-shaped host data into immutable Sumi arrays
and dictionaries. It rejects cycles, accessors, sparse arrays, non-finite
numbers, class instances, and other values that have no unambiguous JSON
meaning. Arbitrary JavaScript objects and functions are never exposed directly
to formula code.

### Compiler layers

- `lex(source)` returns tokens with explicit leading and trailing trivia, plus
  lexical diagnostics.
- `parse(source)`, `parseFileModule(source)`, and `parseExpression(source)`
  return the token stream, lossless CST, and diagnostics for their respective
  roots.
- `lower(parseResult)`, `lowerFileModule(parseResult)`, and
  `lowerExpression(parseResult)` create semantic ASTs.
- `resolve(program)` and `resolveExpression(expression)` assign lexical
  identities and compute free host names.
- `evaluate(...)` and `evaluateExpression(...)` evaluate already analyzed
  trees.
- `analyze(...)`, `analyzeExpression(...)`, `interpret(...)`, and
  `interpretExpression(...)` provide the corresponding complete paths.

Host code constructs immutable composite values with `arrayValue` and
`dictionaryValue`, and wraps host callables with `nativeFunction`. Every
external binding and native-function result is checked at runtime; plain
mutable JavaScript arrays, maps, and objects are deliberately not accepted as
formula values.
