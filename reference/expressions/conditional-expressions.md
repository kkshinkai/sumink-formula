# Conditional expressions

```text
IfExpression =
    "if" "(" Expression ")" Expression ("else" Expression)?
```

The condition must evaluate to a Boolean. When it is `true`, the consequent is
evaluated and supplies the result. When it is `false`, the alternative is
evaluated and supplies the result if present; otherwise the result is `nil`.
The unselected expression is not evaluated.

An `else` belongs to the nearest preceding `if` without an alternative:

```sumi
if (first) if (second) a else b
```

The `else b` above is the alternative of `if (second)`.
