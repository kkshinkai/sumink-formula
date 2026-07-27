# Dictionary expressions

```text
DictionaryExpression = "{}"
                     | "{" ExplicitDictionaryEntry ("," DictionaryEntry)* ","? "}"
                     | "{" ShorthandDictionaryEntry "," (DictionaryEntry ("," DictionaryEntry)* ","?)? "}"
DictionaryEntry = ExplicitDictionaryEntry | ShorthandDictionaryEntry
ExplicitDictionaryEntry = StaticKey ":" Expression
                        | "[" Expression "]" ":" Expression
ShorthandDictionaryEntry = IDENTIFIER
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

An identifier entry is shorthand for a String key whose value is read from the
identifier:

```sumi
let name = "Ada";
let active = true;
{name, active}
```

The final expression is equivalent to:

```sumi
{name: name, active: active}
```

The key introduced by a shorthand entry is not an identifier reference. The
value is. `{external,}` therefore has one external dependency named `external`.

A Dictionary whose first entry uses shorthand must contain the following
comma. This preserves the distinction between a one-entry shorthand Dictionary
and a block:

```sumi
{value}   // Block whose value is value
{value,}  // Dictionary equivalent to {value: value}
```

Shorthand entries can be mixed with both explicit entry forms:

```sumi
{
  name,
  active: true,
  [preferredKey]: preferredValue,
}
```

Removing entries from a Dictionary must not remove the comma from a remaining
sole shorthand entry. Rewriting `{x, y}` as `{x}` changes its meaning to a
Block; the corresponding one-entry Dictionary is `{x,}`.

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
