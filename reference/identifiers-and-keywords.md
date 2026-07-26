# Identifiers and keywords

```text
IDENTIFIER = ("_" | ID_START) ("_" | ID_CONTINUE)*
```

`ID_START` and `ID_CONTINUE` are the Unicode 16.0.0 properties of those names.
The underscore is additionally accepted in both positions.

Identifiers are case-sensitive and are compared exactly as written. The
language performs neither Unicode normalization nor locale-dependent case
folding.

The following spellings are reserved and cannot be identifiers:

```text
do      if      then    elif    else
let     in      match   case
nil     true    false
not     and     or
```

The standalone spelling `_` is an identifier token outside a pattern and a
wildcard inside a pattern. A longer spelling such as `_value` is always an
ordinary identifier.

Every identifier expression refers to the nearest enclosing lexical binding of
that name. If no such binding exists, it refers to an external binding supplied
with the program. Evaluation is an error when a required external binding is
absent or is not a valid runtime value.

An inner binding may shadow an outer binding. Two patterns may not bind the
same name in one scope.

The static dependency set of a program is the set of its external references.
It is determined without evaluation and therefore includes references in
closure bodies and branches that might not run. The external bindings read by
one evaluation must be a subset of that static set.

Member names in `value.name` and identifier keys in `{name: value}` are not
identifier expressions and do not create dependencies. A computed selector or
computed object key is an expression and may contain dependencies.
