# Values

The runtime values are:

```text
nil
Boolean
Number
String
Array<Value>
Object<String, Value>
Function
```

Numbers use IEEE 754 binary64 values. Only finite numbers are values of the
language.

Arrays and objects are immutable values. The containment graph formed by array
elements and object values is finite and acyclic. Objects have unique string
keys. Arrays retain element order.

Functions are values and compare by identity. Their captured bindings are part
of the function value but are not traversed by equality.
