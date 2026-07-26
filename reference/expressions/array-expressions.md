# Array expressions

```text
ArrayExpression = "[" ArrayElements? "]"
ArrayElements = Expression ("," Expression)* ","?
```

An array expression produces an array containing the values of its element
expressions. The empty form `[]` produces an empty array.
