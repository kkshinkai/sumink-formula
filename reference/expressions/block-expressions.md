# Block expressions

```text
BlockExpression = "{" Statement+ "}" | "{" Statement* Expression "}"
```

A block creates a lexical scope and executes its statements in source order.
If it ends with an expression that is not followed by a semicolon, that
expression supplies the value of the block. Otherwise its value is `nil`.

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
