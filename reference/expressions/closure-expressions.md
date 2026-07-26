# Closure expressions

```text
ClosureExpression = Pattern "->" Expression
                  | "(" ClosureParameters? ")" "->" Expression
ClosureParameters = Pattern ("," Pattern)* ","?
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

Every invocation creates a fresh parameter scope. Parameter bindings from one
invocation are never shared with another invocation, including recursive and
reentrant invocations.

A closure that outlives the evaluation in which it was created retains both
its local bindings and that evaluation's external bindings. It does not resolve
captured names again in the environment of a later caller.

A closure expression does not by itself give the function a binding through
which it can call itself. A recursive named closure is declared by an
[`fn` statement](../statements/fn-statements.md).
