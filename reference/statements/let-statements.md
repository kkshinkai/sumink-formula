# `let` statements

```text
LetStatement = "let" Pattern "=" Expression ";"
```

The initializer is evaluated before its pattern is bound. The resulting value
must match the pattern. A failed pattern is an error.

Names introduced by the pattern are visible to following statements in the
same lexical scope. They are not visible in the initializer or in preceding
statements. A `let` binding is therefore neither recursive nor hoisted.

```sumi
let outer = 1;
{
  let inner = outer + 1;
  inner
}
```

A name may not be declared more than once in one lexical scope. A nested scope
may declare the same name as an outer scope.
