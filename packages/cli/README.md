# `sumi` CLI

The first CLI executes one `.sumi` source file:

```sh
sumi program.sumi
```

The program's final value is intentionally not printed. The CLI provides a
single host binding, `print(value)`, which writes one value and a newline to
standard output and returns `nil`.

```sumi
print("Hello, world!");
```

Use `sumi --help` for the complete first-version command syntax.
