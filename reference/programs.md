# Programs

```text
Program = Statement*
```

A program may be empty. Its statements are executed in source order. Successful
execution of a program has the value `nil`; an expression statement does not
make its value the value of the program.

The program is a lexical scope. All `fn` names in the program are visible
throughout that scope. A name introduced by a `let` statement is visible only
to later statements in the program.
