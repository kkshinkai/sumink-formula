# `let` expressions

```text
LetExpression = "let" LetBindings "in" Expression
LetBindings = LetBinding (";" LetBinding)*
LetBinding = Pattern "=" Expression
```

A `let` expression creates one lexical scope containing all names introduced
by its binding patterns. That scope covers every initializer and the body after
`in`. The bindings form one recursive group; they are not a sequence of nested,
non-recursive bindings.

Evaluation proceeds as follows:

1. A still-uninitialized slot is created for every name bound by the group.
2. The initializers are evaluated once each, in source order, in the recursive
   scope.
3. Each resulting value is matched against its binding pattern and initializes
   the names in that pattern. A failed pattern is an error.
4. After all initializers succeed, the expression following `in` is evaluated
   in the same scope and supplies the result.

All names in the group are lexically visible from the beginning, but a name
cannot be read until its initializer has completed. Reading an uninitialized
binding is an error. Consequently this expression is an error rather than a
reference to the outer `x`:

```sumi
let x = 1 in
  let x = x in x
```

The inner `x` shadows the outer `x` throughout the inner initializer and body.

Creating a closure does not evaluate its body. Closures in one `let` group can
therefore capture the same recursive scope and call one another regardless of
their declaration order:

```sumi
let even = (n) ->
      if n == 0 then true else odd(n - 1);
    odd = (n) ->
      if n == 0 then false else even(n - 1)
in even(10)
```

The group above evaluates to `true`. By contrast, an initializer that directly
reads a later binding fails before that binding has been initialized:

```sumi
let first = second;
    second = 2
in first
```

The recursive scope ends with the expression following `in`, except that a
closure returned from the expression retains the bindings it captured. A
nested lexical scope may shadow a name from the group. Repeating a bound name
within the same group is an error. A semicolon separates bindings; a trailing
semicolon before `in` is not permitted.
