# Statements

```text
Statement = EmptyStatement
          | LetStatement
          | FnStatement
          | ExpressionStatement
```

Statements occur directly in a Program or Block. A Module body admits only
Empty, `let`, and `fn` statements; an Expression statement in a Module is an
error.

- [Empty statements](./empty-statements.md)
- [`let` statements](./let-statements.md)
- [`fn` statements](./fn-statements.md)
- [Expression statements](./expression-statements.md)
