# `fn` statements

```text
FnStatement = "fn" IDENTIFIER "(" FnParameters? ")" "=" Expression ";"
FnParameters = Pattern ("," Pattern)* ","?
```

An `fn` statement declares a name whose value is an ordinary closure. Calling
it follows the same parameter matching, lexical capture, and invocation rules
as calling a closure expression.

All `fn` names declared in one lexical scope are visible throughout that scope,
including in every function body in the group. They may call themselves and
one another regardless of source order:

```sumi
fn even(n) = if (n == 0) true else odd(n - 1);
fn odd(n) = if (n == 0) false else even(n - 1);
```

A `fn` body can refer to a `let` binding that precedes the declaration. A later
`let` declaration is not in its lexical scope. If a function is called while a
captured earlier `let` is still being initialized, reading that binding is an
uninitialized-binding error.

The function name is not a distinct runtime category or namespace. A nested
scope may shadow it, and the closure may be passed, returned, or stored like
any other function value.
