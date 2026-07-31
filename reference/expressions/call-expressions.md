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

The Block and Dictionary distinction remains unchanged in a braced argument:

```sumi
f {value}   // passes the result of a Block
f {value,}  // passes {value: value}
```

Postfix forms may continue after a braced argument, including another braced
argument. When a closure head occurs in the result position of a braced Block,
its body consumes the remainder of that Block through the matching `}`:

```sumi
map(values) {
  value ->
  let normalized = normalize(value);
  normalized + 1
}
```

This call has one braced argument. The argument is the closure produced as the
Block result. Its body contains both the `let` statement and the final
expression. Neither is evaluated before `map` invokes the closure.

The rule is unchanged when calls are chained:

```sumi
pipeline(source) {
  value ->
  let first = decode(value);
  validate(first)
} {
  value -> encode(value)
}
```

Each pair of braces is one argument to the call immediately to its left. Each
closure body ends at the matching brace that contains its closure head.

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
