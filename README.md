# Sumink Formula

This workspace contains the first-version Sumink Formula language core. Its
current scope contains [`packages/core`](./packages/core), a handwritten front
end, lexical resolver, and tree-walking interpreter, plus a minimal
[`sumi`](./packages/cli) command-line runner.

The first-version language is defined by the
[`Sumink Formula Language Reference`](./reference.md). It specifies lexical
forms, syntax, and observable semantics in one document.

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

The first CLI executes a file without printing its final value. Programs can
write to standard output through the CLI-provided `print(value)` binding. No
editor, LSP, or VS Code package is part of this version.
