# Closure expressions

```text
ClosureExpression = ClosureHead Expression
ClosureHead = Pattern "->"
            | "(" ClosureParameters? ")" "->"
ClosureParameters = Pattern ("," Pattern)* ","?
BlockResultClosure = ClosureHead BlockBody
```

A closure expression is a lambda expression. Evaluating it creates a function
without evaluating its body. The function retains the lexical environment in
which it was created. Invoking it later resolves every captured name to the
same binding, even if the caller has a binding with the same spelling.

This expression evaluates to `1`:

```sumi
{
  let x = 1;
  let f = () -> x;
  {
    let x = 2;
    f()
  }
}
```

The `x` used by `f` is the binding visible where the closure was created, not
the binding visible where it is called.

Calling a closure requires exactly as many arguments as it has parameter
patterns. The argument values are matched against those patterns from left to
right. A failed parameter pattern is an error. The names introduced by the
patterns are visible only in the closure body.

A closure outside the result position of a Block has one Expression as its
body. A closure head in the result position of a Block instead forms a
`BlockResultClosure`. Its body is the `BlockBody` that follows the arrow and
extends through the matching `}` of that Block:

```sumi
let transform = {
  value ->
  let normalized = normalize(value);
  validate(normalized)
};
```

Evaluating the enclosing Block creates the closure without executing
`normalize` or `validate`. Each invocation evaluates the statements and result
of that Block body.

Parentheses can make a closure an ordinary expression statement instead of the
result closure of the surrounding Block:

```sumi
{
  (value -> transform(value));
  finalValue
}
```

This Block evaluates the parenthesized closure, discards it, and then evaluates
to `finalValue`.

A closure always has explicit parameter syntax. Match arms do not form a
separate closure expression. A function that selects among several patterns
writes its subject explicitly:

```sumi
value -> value match {
  0 -> "zero",
  number -> number,
}
```

Every invocation creates a fresh parameter scope. Parameter bindings from one
invocation are never shared with another invocation, including recursive and
reentrant invocations.

A closure that outlives the evaluation in which it was created retains both
its local bindings and that evaluation's external bindings. It does not resolve
captured names again in the environment of a later caller.

A closure expression does not by itself give the function a binding through
which it can call itself. A recursive named closure is declared by an
[`fn` statement](../statements/fn-statements.md).
