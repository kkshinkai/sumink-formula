# Source text

A source file is a sequence of Unicode scalar values. An unpaired UTF-16
surrogate is not a Unicode scalar value and is an error wherever it occurs in
the input.

The only whitespace characters are space (`U+0020`), horizontal tab
(`U+0009`), carriage return (`U+000D`), and line feed (`U+000A`). Whitespace may
separate tokens and otherwise has no meaning.

```text
Comment = LineComment | BlockComment

LineComment = "//" LINE_COMMENT_CHARACTER*

BlockComment = "/*" BlockCommentItem* "*/"
BlockCommentItem = BLOCK_COMMENT_CHARACTER | BlockComment
```

`LINE_COMMENT_CHARACTER` is any Unicode scalar value other than carriage return
or line feed. The line break after a line comment is not part of the comment.

`BLOCK_COMMENT_CHARACTER` is any Unicode scalar value that is not the start of
`/*` or `*/`. Block comments may be nested. The first `*/` at the current nesting
depth closes the comment. Reaching the end of the source before the outermost
block comment is closed is an error.

Comments may separate tokens and otherwise have no meaning. `///` is a line
comment and `/** ... */` is a block comment; this version gives neither spelling
additional meaning.

For example:

```sumi
// A line comment
let answer = 40 + 2; // The line break is outside this comment.

/* An outer comment
   /* A nested comment */
   continues here. */
print(answer);
```

Tokens are taken as long as possible. For example, `letter` is one identifier,
not the keyword `let` followed by the identifier `ter`.
