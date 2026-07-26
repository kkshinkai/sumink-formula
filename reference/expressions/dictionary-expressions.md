# Dictionary expressions

```text
DictionaryExpression = "{}"
                     | "{" DictionaryEntries ","? "}"
DictionaryEntries = DictionaryEntry ("," DictionaryEntry)*
DictionaryEntry = StaticKey ":" Expression
                | "[" Expression "]" ":" Expression
StaticKey = IDENTIFIER | STRING | NUMBER
```

A Dictionary expression evaluates its entries in source order. A computed key
expression is evaluated before its value expression. Every runtime value kind
may be a key.

An identifier static key contributes its spelling as a String. A string or
number static key contributes the value of that literal:

```sumi
{name: "Ada", 1: "one"}
```

Computed keys use brackets:

```sumi
{
  [[1, 2]]: "array key",
  [{name: "Ada"}]: "dictionary key"
}
```

If a key is equal to an earlier key, the later entry replaces the earlier
value. The original key value and its position are retained. Key equality is
the equality defined by `==`.

Dictionary equality compares mappings and is independent of insertion order:

```sumi
{a: 1, b: 2} == {b: 2, a: 1}
```

The comparison above has the value `true`.

Dictionary values retain insertion order for iteration and deterministic
display. A Dictionary is not a record and does not restrict its keys to
strings.
