# Match expressions

```text
MatchExpression = MatchTestExpression | MatchSelectionExpression
MatchTestExpression = Expression "match" Pattern

MatchSelectionExpression =
    Expression "match" "{" MatchCase+ MatchElse? "}"

MatchCase = "case" Pattern "->" Expression
MatchElse = "else" "->" Expression
```

A match test evaluates its subject once and returns whether the pattern accepts
that value. It does not expose bindings outside the test. An identifier pattern
in a match test therefore accepts every value, but its name cannot be used by a
surrounding expression.

A match selection evaluates its subject once, then tests cases in source order.
The result expression of the first accepting case is evaluated. Names bound by
that case are visible only in its result expression. Cases that follow it and
the optional `else` expression are not evaluated.

If no case accepts the value, the `else` expression is evaluated when present.
Otherwise evaluation is an error. A match selection must contain at least one
`case`; `else` alone is not permitted.
