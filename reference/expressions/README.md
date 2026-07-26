# Expressions

```text
Expression =
    LiteralExpression
  | IdentifierExpression
  | ArrayExpression
  | ObjectExpression
  | GroupedExpression
  | ClosureExpression
  | BlockExpression
  | IfExpression
  | LetExpression
  | CallExpression
  | OperatorExpression
  | SelectorExpression
  | MatchExpression

IdentifierExpression = IDENTIFIER
```

Evaluation is strict. Where an expression evaluates several operands, it does
so from left to right. This applies to program and block expressions, array
elements, object members, call arguments, and `let` initializers. A computed
object member evaluates its key before its value, and a call evaluates its
callee before its arguments.

Conditional expressions, `and`, `or`, and match selection evaluate only the
branch selected by their own rules.

Postfix and operator expressions use the following precedence, from highest to
lowest:

| Precedence | Form | Associativity |
| ---: | --- | --- |
| 10 | call `f(...)`, field selection `value.name`, computed selection `value[key]` | left |
| 9 | prefix `-`, `not` | right |
| 8 | `*`, `/`, `%` | left |
| 7 | `+`, `-` | left |
| 6 | named infix call `left function right` | left |
| 5 | `<`, `<=`, `>`, `>=` | left |
| 4 | `==`, `!=` | left |
| 3 | `subject match pattern`, `subject match { ... }` | left |
| 2 | `and` | left |
| 1 | `or` | left |

The individual expression forms are:

- [Literal expressions](./literal-expressions.md)
- [Grouped expressions](./grouped-expressions.md)
- [Array expressions](./array-expressions.md)
- [Object expressions](./object-expressions.md)
- [Closure expressions](./closure-expressions.md)
- [Block expressions](./block-expressions.md)
- [Conditional expressions](./conditional-expressions.md)
- [`let` expressions](./let-expressions.md)
- [Call expressions](./call-expressions.md)
- [Operator expressions](./operator-expressions.md)
- [Selector expressions](./selector-expressions.md)
- [Match expressions](./match-expressions.md)
