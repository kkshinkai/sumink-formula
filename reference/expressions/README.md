# Expressions

```text
Expression =
    LiteralExpression
  | IdentifierExpression
  | ArrayExpression
  | DictionaryExpression
  | GroupedExpression
  | ClosureExpression
  | BlockExpression
  | IfExpression
  | CallExpression
  | OperatorExpression
  | SelectorExpression
  | MatchExpression

IdentifierExpression = IDENTIFIER
```

Evaluation is strict. An array evaluates its elements in source order. A
dictionary evaluates each key before its value and its entries in source order.
A call evaluates its callee before its arguments, and arguments in source order.

Conditional expressions, `and`, `or`, and match selection evaluate only the
branch selected by their own rules.

Postfix and operator expressions use the following precedence, from highest to
lowest:

| Precedence | Form | Associativity |
| ---: | --- | --- |
| 10 | call `f(...)`, braced call `f {...}`, field selection `value.name`, computed selection `value[key]` | left |
| 9 | prefix `-`, `not` | right |
| 8 | `*`, `/`, `%` | left |
| 7 | `+`, `-` | left |
| 6 | named infix call `left function right` | left |
| 5 | `<`, `<=`, `>`, `>=` | left |
| 4 | `==`, `!=` | left |
| 3 | `subject match pattern`, `subject match { ... }` | left |
| 2 | `and` | left |
| 1 | `or` | left |

The arrow in an ordinary closure expression has lower precedence than every
postfix and operator form. Its Expression body extends as far to the right as
the surrounding grammar permits. When a closure head occurs in Block result
position, the Block-specific rule applies instead: its body is the remainder
of that Block through the matching `}`.

The individual expression forms are:

- [Literal expressions](./literal-expressions.md)
- [Grouped expressions](./grouped-expressions.md)
- [Array expressions](./array-expressions.md)
- [Dictionary expressions](./dictionary-expressions.md)
- [Closure expressions](./closure-expressions.md)
- [Block expressions](./block-expressions.md)
- [Conditional expressions](./conditional-expressions.md)
- [Call expressions](./call-expressions.md)
- [Operator expressions](./operator-expressions.md)
- [Selector expressions](./selector-expressions.md)
- [Match expressions](./match-expressions.md)
