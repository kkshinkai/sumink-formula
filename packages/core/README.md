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
Unresolved lexical names are explicit host dependencies. Recursive `let` frames
use once-initialized slots, and closures capture the frame itself; this is the
mechanism behind lexical shadowing, escaping closures, and mutual recursion.

Identifier classification is pinned to Unicode 16.0.0 tables rather than the
host JavaScript engine's evolving Unicode property-escape implementation.

## Engineering reference

The scanner/parser/diagnostic/binder boundaries were studied against the
official `microsoft/TypeScript` implementation at commit
`637d5746b70257028fb95aad32ddec6b26ab0a14` (the TypeScript implementation, not
TypeScript-Go), principally `scanner.ts`, `parser.ts`, `types.ts`, and
`binder.ts` under `src/compiler`. The architecture is adapted rather than
copied: TypeScript's AST is not lossless, while this package requires a
distinct lossless CST.

## Public entry points

- `lex(source)` returns all tokens, including trivia, and lexical diagnostics.
- `parse(source)` returns the token stream, lossless CST, and diagnostics.
- `lower(parseResult)` creates the semantic AST.
- `resolve(program)` assigns lexical identities and computes host dependencies.
- `evaluate(program, resolution, options)` evaluates an already analyzed tree.
- `analyze(source)` and `interpret(source, options)` provide the complete paths.

Host code constructs immutable composite values with `arrayValue` and
`objectValue`, and wraps host callables with `nativeFunction`. Every external
binding and native-function result is checked at runtime; plain mutable
JavaScript arrays and objects are deliberately not accepted as formula values.
