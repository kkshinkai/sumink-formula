# Expression statements

```text
ExpressionStatement = Expression ";"
```

An expression statement evaluates its expression and discards the resulting
value. Its effects on host-provided functions are not discarded.

At program level, every expression must be an expression statement. In a block,
an expression without a following semicolon may instead be the block's result.

A closure head in Block result position starts a `BlockResultClosure` and is
not an Expression Statement. Semicolons after its arrow belong to its Block
body. Parenthesizing the closure makes it an ordinary expression that can be
terminated by a semicolon:

```sumi
{
  (value -> value + 1);
  result
}
```
