# Patterns

```text
Pattern = LiteralPattern | IdentifierPattern | WildcardPattern
LiteralPattern = Literal
IdentifierPattern = IDENTIFIER
WildcardPattern = "_"
```

A literal pattern accepts a value equal to its literal under the equality rules
of the language and introduces no binding.

An identifier pattern accepts every value. In a closure or `fn` parameter, a
`let` statement, or a match arm, it binds that value to its identifier. The
binding's scope is respectively the function body, the statements following
the `let` in the same scope, or that arm's result expression. An identifier
pattern in a match test introduces no binding.

The wildcard pattern accepts every value and introduces no binding.
