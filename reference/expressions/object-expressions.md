# Object expressions

```text
ObjectExpression = "{" ObjectMembers? "}"
ObjectMembers = ObjectMember ("," ObjectMember)* ","?
ObjectMember = ObjectKey ":" Expression
ObjectKey = IDENTIFIER | STRING | "[" Expression "]"
```

An identifier key contributes its spelling. A string key contributes its
string value. A computed key must evaluate to a string or finite number; a
number is converted to a string using the ECMAScript decimal number-to-string
conversion.

If several members produce the same key, the last such member supplies the
object's value for that key. The earlier member expressions are still
evaluated.
