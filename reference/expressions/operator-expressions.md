# Operator expressions

```text
OperatorExpression = PrefixOperatorExpression | InfixOperatorExpression
PrefixOperatorExpression = PrefixOperator Expression
InfixOperatorExpression = Expression InfixOperator Expression

PrefixOperator = "-" | "not"
InfixOperator =
    "+" | "-" | "*" | "/" | "%"
  | "<" | "<=" | ">" | ">="
  | "==" | "!="
  | "and" | "or"
```

Prefix `-` accepts a finite number. `not` accepts a Boolean.

`+` adds two finite numbers or concatenates two strings. `-`, `*`, `/`, and
`%` accept two finite numbers. Division or remainder by zero is an error. Every
numeric result must be finite.

`<`, `<=`, `>`, and `>=` compare either two finite numbers or two strings. The
two operands must have the same kind. String ordering is lexicographic by
UTF-16 code unit.

`and` and `or` accept Booleans. `and` evaluates its right operand only when its
left operand is `true`; `or` evaluates its right operand only when its left
operand is `false`.

`==` and `!=` perform no coercion. Null and Boolean values compare by value.
Finite numbers compare numerically, with positive and negative zero equal.
Strings compare by their contents. Arrays compare element by element in order.
Dictionaries compare by their key-value mappings without regard to insertion
order; keys and values use these same equality rules recursively. Functions
compare by identity. Values of different kinds are unequal.
