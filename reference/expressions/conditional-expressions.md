# Conditional expressions

```text
IfExpression =
    "if" Expression "then" Expression
    ElifClause*
    "else" Expression

ElifClause = "elif" Expression "then" Expression
```

Conditions must evaluate to Booleans. Conditions are considered in source
order. The result expression paired with the first `true` condition is
evaluated and becomes the value of the conditional. If every condition is
`false`, the `else` expression is evaluated. No unselected result expression is
evaluated.

The `else` expression is required.
