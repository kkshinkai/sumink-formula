# Match expressions

```text
MatchExpression = MatchTestExpression | MatchSelectionExpression
MatchTestExpression = Expression "match" Pattern

MatchSelectionExpression =
    Expression "match" "{" MatchArms ","? "}"

MatchArms = MatchArm ("," MatchArm)*
MatchArm = Pattern "->" Expression
```

A match test evaluates its subject once and returns whether the pattern accepts
that value. It does not expose bindings outside the test. An identifier pattern
in a match test therefore accepts every value, but its name cannot be used by a
surrounding expression.

A match selection evaluates its subject once, then tests arms in source order.
The result expression of the first accepting arm is evaluated. Names bound by
that arm are visible only in its result expression. Arms that follow it are not
evaluated.

The wildcard pattern supplies a fallback without introducing a binding:

```sumi
status match {
  "open" -> process(status),
  "closed" -> archive(status),
  _ -> reportUnknown(status),
}
```

If no arm accepts the value, evaluation is an error. A match selection must
contain at least one arm. Match arms are comma-separated and may have a
trailing comma. There is no `case` introducer and no match-specific `else` arm.
