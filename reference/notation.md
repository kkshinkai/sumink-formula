# Notation

Grammar fragments use the following notation:

```text
Production = Sequence Alternative
Alternative = First | Second
Optional = Item?
ZeroOrMore = Item*
OneOrMore = Item+
Grouped = (First Second)*
```

A quoted string denotes exact source text. A name in `PascalCase` denotes
another syntactic production. A name in `UPPER_CASE` denotes a lexical token or
a Unicode character property. Whitespace and line breaks inside a grammar
fragment are only formatting.

When the reference says that a construct “is an error”, an implementation must
reject it. The text and presentation of that error are not prescribed.
