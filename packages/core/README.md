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

The CST retains every source token and trivia token. Recovery inserts explicit
zero-width missing-token nodes without modifying the source stream. The AST is
separate so editor recovery structure cannot become executable semantics.

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

## Public entry points

- `lex(source)` returns all tokens, including trivia, and lexical diagnostics.
- `parse(source)` returns the token stream, lossless CST, and diagnostics.
- `lower(parseResult)` creates the semantic AST.
- `resolve(program)` assigns lexical identities and computes host dependencies.
- `evaluate(program, resolution, options)` evaluates an already analyzed tree.
- `analyze(source)` and `interpret(source, options)` provide the complete paths.

Host code constructs immutable composite values with `arrayValue` and
`dictionaryValue`, and wraps host callables with `nativeFunction`. Every
external binding and native-function result is checked at runtime; plain
mutable JavaScript arrays, maps, and objects are deliberately not accepted as
formula values.
