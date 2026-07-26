# Source text

A source file is a sequence of Unicode scalar values. An unpaired UTF-16
surrogate is not a Unicode scalar value and is an error wherever it occurs in
the input.

The only whitespace characters are space (`U+0020`), horizontal tab
(`U+0009`), carriage return (`U+000D`), and line feed (`U+000A`). Whitespace may
separate tokens and otherwise has no meaning.

Tokens are taken as long as possible. For example, `letter` is one identifier,
not the keyword `let` followed by the identifier `ter`.
