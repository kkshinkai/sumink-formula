# Values

The runtime values are:

```text
null
Boolean
Number
String
Array<Value>
Dictionary<Value, Value>
Function
```

Numbers use IEEE 754 binary64 values. Only finite numbers are values of the
language.

Arrays and dictionaries are immutable values. The containment graph formed by
array elements and dictionary keys and values is finite and acyclic. Arrays
retain element order.

A dictionary contains unique keys and retains the first insertion order of
those keys. Every value kind, including arrays, dictionaries, and functions,
may be a key. Inserting a key equal to an existing key replaces its value
without changing its stored key or position.

Functions are values and compare by identity. Their captured bindings are part
of the function value but are not traversed by equality.
