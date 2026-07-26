# Selector expressions

```text
SelectorExpression = FieldSelectorExpression | ComputedSelectorExpression
FieldSelectorExpression = Expression "." IDENTIFIER
ComputedSelectorExpression = Expression "[" Expression "]"
```

A field selector requires an object and selects the field whose key is the
identifier spelling. A missing field has the value `nil`.

A computed selector accepts an array or object. Array selection requires an
integer index between `0` and `2^53 - 1`, inclusive; an index outside the array
has the value `nil`. Object selection requires a string or finite number key. A
numeric key is converted to a string by the same rule as a computed object key.
A missing object key has the value `nil`.

Applying a selector to a value of the wrong kind, or using a selector of the
wrong kind for its receiver, is an error.
