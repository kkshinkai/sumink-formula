# Programs

```text
Program = ProgramItem*
ProgramItem = Statement | ImportDeclaration | ModuleDeclaration

FileModule = ModuleItem*
ModuleItem = EmptyStatement
           | LetStatement
           | FnStatement
           | ImportDeclaration
           | ExportDeclaration
           | ModuleDeclaration
```

A Program is an executable root. It may be empty. Its statements are executed
in source order. Successful execution has the value `nil`; an expression
statement does not make its value the value of the Program.

A File Module is a declaration-only root loaded by a File Module import. An
expression statement directly in a File Module is an error. The `.sumi` suffix
does not determine which root is used: an entry source is parsed as a Program,
and a source returned by a File Module loader is parsed as a File Module.

The program is a lexical scope. All `fn` names in the program are visible
throughout that scope. A name introduced by a `let` statement is visible only
to later statements in the program.

Import declarations and Module declarations are statically visible throughout
their containing Program or Module. They are described in
[Modules](./modules.md).
