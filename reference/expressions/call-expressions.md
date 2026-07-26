# Call expressions

```text
CallExpression = OrdinaryCallExpression | NamedInfixCallExpression
OrdinaryCallExpression = Expression "(" CallArguments? ")" | Expression BracedArgument
CallArguments = Expression ("," Expression)* ","?
BracedArgument = DictionaryExpression | BlockExpression
NamedInfixCallExpression = Expression IDENTIFIER Expression
```

An ordinary call evaluates the callee and then its arguments. The callee must
be a function.

A braced argument is one argument. The following pairs are equivalent:

```sumi
f({})
f {}

f({;})
f {;}
```

Postfix forms may continue after a braced argument, including another braced
argument. The source below has no special trailing-lambda construct:

```sumi
f { x -> x + 1 }
```

The argument is a block whose result is the ordinary closure expression
`x -> x + 1`.

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
