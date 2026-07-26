# Block expressions

```text
BlockExpression = "do" "{" BlockElements? "}"
BlockElements = Expression (";" Expression)* ";"?
```

A block evaluates its expressions in source order and has the value of its
final expression. An empty block has the value `nil`. A trailing semicolon does
not change the result.
