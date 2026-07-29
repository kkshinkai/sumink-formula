# Sumink Formula

This workspace contains the first-version Sumink Formula language core. Its
current scope contains [`packages/core`](./packages/core), a handwritten front
end, lexical resolver, and tree-walking interpreter, plus a minimal
[`sumi`](./packages/cli) command-line runner.

The first-version language is defined by the
[`Sumi Language Reference`](./reference.md). It specifies lexical forms,
syntax, and observable semantics.

`@sumink-formula/core` also exposes an application embedding API. A host defines
ordinary outer bindings and recursively nested Native Modules, compiles either
a standalone formula expression or a `.sumi` Program once, and evaluates it
repeatedly with immutable input snapshots. Programs may also declare nested
Formula Modules and load File Modules through a host-supplied loader.

Run the complete local gate with:

```sh
pnpm check
```

It performs strict TypeScript checking, the Vitest suite, and the distributable
ES module/declaration build.

Build and run a `.sumi` file with:

```sh
pnpm build
pnpm exec sumi examples/hello.sumi
```

The first CLI executes every statement in the entry file and resolves relative
File Module specifiers from the referring file. Successful Program execution
has the value `nil`, which the CLI does not print. Programs can write to standard
output through the CLI-provided `print(value)` binding. No editor, LSP, or VS
Code package is part of this version.
