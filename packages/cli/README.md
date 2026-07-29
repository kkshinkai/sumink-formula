# `sumi` CLI

The first CLI executes one `.sumi` source file:

```sh
sumi program.sumi
```

Successful program execution has the value `nil`, which is not printed. The CLI
provides a single host binding, `print(value)`, which writes one value and a
newline to standard output and returns `nil`. Dictionaries with non-string keys
are displayed using computed-key notation.

```sumi
print("Hello, world!");
```

Use `sumi --help` for the complete first-version command syntax.

The entry file is parsed as an executable Program. `import {...} from "path"`
loads declaration-only File Modules. The CLI resolves each relative specifier
against the referring file, canonicalizes it through the host filesystem, and
does not infer extensions or directory indexes. Diagnostics and call notes use
the canonical path of the source that produced them.
