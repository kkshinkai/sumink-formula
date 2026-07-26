# Call expressions

```text
CallExpression = OrdinaryCallExpression | NamedInfixCallExpression
OrdinaryCallExpression = Expression "(" CallArguments? ")"
CallArguments = Expression ("," Expression)* ","?
NamedInfixCallExpression = Expression IDENTIFIER Expression
```

An ordinary call evaluates the callee and then its arguments. The callee must
be a function.

A named infix call has exactly the meaning of an ordinary two-argument call:

```sumi
left function right
```

is equivalent to:

```sumi
function(left, right)
```

It therefore evaluates `function` first, followed by `left` and `right`.

The function name is an ordinary identifier expression. It uses the same
lexical resolution and external-binding rules as any other name; named infix
calls do not have a separate namespace or a parser-defined collection of
functions.
