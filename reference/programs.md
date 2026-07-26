# Programs

```text
Program = Expression (";" Expression)* ";"?
```

A program contains at least one expression. Its expressions are evaluated in
source order, and its value is the value of the final expression. A trailing
semicolon does not change that value.
