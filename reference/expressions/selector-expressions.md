# Selector expressions

```text
SelectorExpression = FieldSelectorExpression | ComputedSelectorExpression
FieldSelectorExpression = Expression "." IDENTIFIER
ComputedSelectorExpression = Expression "[" Expression "]"
```

A field selector requires a dictionary and is exactly equivalent to selecting
with the identifier spelling as a string key:

```sumi
value.name
value["name"]
```

A computed selector accepts an array or dictionary. Array selection requires an
integer index between `0` and `2^53 - 1`, inclusive; an index outside the array
has the value `nil`. Dictionary selection accepts a key of any runtime value
kind. A missing dictionary key has the value `nil`.

Applying a selector to a value of the wrong kind, or using a selector of the
wrong kind for its receiver, is an error.
