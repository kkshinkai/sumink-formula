# Block expressions

```text
BlockExpression = "{" NonemptyBlockBody "}"
NonemptyBlockBody = Statement+ | Statement* BlockResult
BlockResult = BlockResultClosure | Expression
BlockResultClosure = ClosureHead BlockBody
BlockBody = Statement* BlockResult?
```

A block creates a lexical scope and executes its statements in source order.
If it ends with a Block result, that result supplies the value of the block.
Otherwise its value is `nil`.

After any preceding Statements have been parsed, a `ClosureHead` starts a
`BlockResultClosure`, not an ordinary `ClosureExpression` or Expression
Statement. This choice is made before considering a semicolon after the first
expression following the arrow. The closure body is the remainder of the
`BlockBody` through the matching `}`. Statements before the closure head belong
to the enclosing Block; statements after the arrow belong to the closure body:

```sumi
{
  let offset = 1;
  value ->
  let adjusted = value + offset;
  adjusted * adjusted
}
```

The value of this Block is a closure. Calling the closure evaluates its body
and returns `adjusted * adjusted`. The closure body returns its final result
when it has one and otherwise returns `nil`, using the same Statement and
result rules as a Block.

The closure body may be empty. `{ value -> }` creates a closure that returns
`nil`.

A semicolon inside a Block-result closure belongs to the closure body:

```sumi
{
  value -> value + 1;
  value * 2
}
```

The result is one closure whose body first discards `value + 1` and then
returns `value * 2`. To place a closure in an Expression Statement of the
enclosing Block, group it explicitly:

```sumi
{
  (value -> value + 1);
  0
}
```

The empty braces `{}` are a Dictionary expression, not a block. An empty block
therefore contains at least one empty statement:

```sumi
{;}
{;;;;;;}
{x}
{x;}
{;; x}
```

The first two expressions have the value `nil`. The third and fifth have the
value of `x`. The fourth has the value `nil`.

A comma after a bare identifier selects Dictionary shorthand instead:

```sumi
{x}      // Block whose value is x
{x;}     // Block whose value is nil
{x,}     // Dictionary equivalent to {x: x}
{x, y}   // Dictionary equivalent to {x: x, y: y}
```

All `fn` names declared directly in a block are visible throughout that block.
A `let` binding is visible only after its statement. Bindings declared in the
block are not visible outside it, except through a closure that captures them.
