# Literal expressions

```text
LiteralExpression = Literal
Literal = STRING | NUMBER | "null" | "true" | "false"
```

`null` denotes the null value. `true` and `false` denote the two Boolean values.

```text
NUMBER = Integer Fraction? Exponent?
Integer = "0" | NONZERO_DIGIT DIGIT*
Fraction = "." DIGIT+
Exponent = ("e" | "E") ("+" | "-")? DIGIT+
DIGIT = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
NONZERO_DIGIT = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
```

A number literal is decimal. A leading zero is not permitted unless the
integer part is exactly `0`. A decimal point must be followed by at least one
digit. The leading `-` in a negative number is a prefix operator and is not
part of the literal. A literal whose conversion produces a non-finite number is
an error.

```text
STRING = DoubleQuotedString | SingleQuotedString
DoubleQuotedString = "\"" DOUBLE_QUOTED_CHARACTER* "\""
SingleQuotedString = "'" SINGLE_QUOTED_CHARACTER* "'"

Escape = "\\" ( "\"" | "'" | "\\" | "b" | "f" | "n" | "r" | "t" | UnicodeEscape )
UnicodeEscape = "u" HEX_DIGIT HEX_DIGIT HEX_DIGIT HEX_DIGIT
HEX_DIGIT = DIGIT | "a" | "b" | "c" | "d" | "e" | "f"
                  | "A" | "B" | "C" | "D" | "E" | "F"
```

An unescaped string character may be any Unicode scalar value at or above
`U+0020` except the delimiter or backslash. A string literal cannot contain an
unescaped line break.

The escapes `\b`, `\f`, `\n`, `\r`, and `\t` denote backspace, form feed, line
feed, carriage return, and horizontal tab. `\"`, `\'`, and `\\` denote the
escaped character. A Unicode escape contributes one UTF-16 code unit; a
surrogate code unit is valid only as part of an adjacent high-surrogate,
low-surrogate pair. A string literal that would produce an unpaired surrogate
is an error.
