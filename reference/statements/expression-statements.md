# Expression statements

```text
ExpressionStatement = Expression ";"
```

An expression statement evaluates its expression and discards the resulting
value. Its effects on host-provided functions are not discarded.

At program level, every expression must be an expression statement. In a block,
an expression without a following semicolon may instead be the block's result.
