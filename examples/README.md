# Sumi examples

Build the workspace, then run any example through the workspace CLI:

```sh
pnpm build
pnpm exec sumi examples/closures.sumi
```

- [`hello.sumi`](./hello.sumi) defines and calls a simple function.
- [`closures.sumi`](./closures.sumi) composes higher-order functions and checks lexical capture.
- [`mutual-recursion.sumi`](./mutual-recursion.sumi) uses a hoisted recursive function group.
- [`tree-processing.sumi`](./tree-processing.sumi) recursively transforms nested Dictionary data.
- [`dictionary-keys.sumi`](./dictionary-keys.sumi) uses arrays, dictionaries, Booleans, and functions as keys.
- [`trailing-blocks.sumi`](./trailing-blocks.sumi) combines curried calls, braced arguments, blocks, dictionaries, and lambdas.
