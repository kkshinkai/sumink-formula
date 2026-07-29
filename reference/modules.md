# Modules

```text
ModuleDeclaration = "module" IDENTIFIER "{" ModuleItem* "}"

ImportDeclaration = LogicalImport | FileImport

LogicalImport = "import" ModulePath ("as" IDENTIFIER | "." ImportSelectorList) ";"
FileImport = "import" (IDENTIFIER | ImportSelectorList) "from" STRING ";"

ExportDeclaration = "export" LetStatement
                  | "export" FnStatement
                  | "export" ModuleDeclaration
                  | "export" ModulePath "." ImportSelectorList ";"

ModulePath = IDENTIFIER ("." IDENTIFIER)*
ImportSelectorList = "{" ImportSelector ("," ImportSelector)* ","? "}"
ImportSelector = IDENTIFIER
               | IDENTIFIER "as" IDENTIFIER
               | IDENTIFIER "as" "_"
               | "*"
```

A Module declaration creates a nested Formula Module. Its name is visible
throughout the containing Module or Program. The declaration does not require a
trailing semicolon.

```sumi
module geometry {
  export let unit = "px";

  export fn area(width, height) =
    width * height;
}
```

A Formula Module has its own lexical scope. It does not inherit ordinary
`let`, `fn`, or external bindings from its enclosing source. A required value
or Module must be imported explicitly. Nested Module declarations and imports
are statically visible throughout their containing Module. All `fn`
declarations in one Module are mutually recursive; `let` declarations become
visible in source order.

## Logical imports

A logical import selects a nested Formula Module, a Module alias, or a Native
Module by Module path:

```sumi
import geometry.{area, unit};
import geometry.{area as calculate};
import geometry as geo;
import app.math.{pi};
```

The first path segment is resolved against nested Modules and Module aliases,
then Native Modules. If no logical root with that name exists, the import is a
Project Module import. Project Module imports are not available in this
version and are an error.

`import geometry as geo;` binds `geo` as a Module alias. A Module and its alias
are not runtime values. They cannot be passed to a function, returned, or
stored in an Array or Dictionary.

Qualification through a Module is static:

```sumi
geo.area(3, 4);
```

For an ordinary runtime value, `.area` remains Dictionary selection. Using a
value as an intermediate or root Module qualifier is an error.

## File imports

A File import obtains a File Module from a host-provided loader:

```sumi
import {length, normalize as unitVector} from "./vector.sumi";
import {internal as _, *} from "./vector.sumi";
import vector from "./vector.sumi";
```

The string after `from` is an opaque specifier. The language does not resolve
relative paths, add file extensions, search directories, or assign path
semantics. The loader receives the specifier and the referring source and
returns source text with a canonical source name.

`import vector from "./vector.sumi";` binds the loaded File Module root to the
Module alias `vector`. Its alias must be one identifier.

Within one compilation, a canonical source name denotes one source text. It is
an error for loader results with the same canonical name to contain different
text. Each File Module is parsed and linked once, and each linked Formula
Module is initialized once per Program evaluation.

All cycles among Formula Modules are errors in this version. This includes
cycles through File Modules and nested Modules.

## Selectors

An import selector list is nonempty and may end with a trailing comma. A
selector has one of four effects:

```sumi
import geometry.{area};            // bind area
import geometry.{area as measure}; // bind measure
import geometry.{internal as _, *};
import geometry.{*};
```

`*` selects every export not named by an earlier selector in the same list. A
list may contain at most one `*`, and it must be last. `name as _` excludes
`name` from the subsequent `*`; it is an error without that subsequent
wildcard. Selecting or excluding a name that the Module does not export is an
error.

Imported names are chosen by this precedence:

```text
visible local declaration
> explicit import selector or Module alias
> wildcard import selector
```

Two candidates at the same precedence for one local name are ambiguous and are
an error. A local declaration may shadow an imported candidate. An explicit
selector may shadow a wildcard candidate.

## Exports

A declaration is private unless it is prefixed by `export`:

```sumi
export let origin = [0, 0];
export fn distance(a, b) = length(a - b);

export module shapes {
  export fn square(size) = size * size;
}
```

An exported `let` must bind an Identifier pattern. An exported `fn` is the same
closure as the local function binding. An exported nested Module remains a
Module, not a runtime value.

Exports from a logical Module path may be selected and renamed:

```sumi
export vector.{length, normalize as normalizeVector};
```

Direct path re-export from a string specifier is not available. The File Module
must first be imported under a Module alias.

Every exported name is unique. An explicit export takes precedence over a
wildcard export of the same name. Multiple explicit exports or multiple
wildcard candidates for one export name are errors.

## Initialization

Linked Formula Modules are initialized dependency-first. Their `fn` slots are
allocated and initialized before strict `let` initializers execute in source
order. Imports refer to the exporter's slot; they do not create a second
closure or re-evaluate an initializer.

An initialization error prevents dependent Modules and the entry Program from
executing. Host effects that occurred before an error are not rolled back. A
new evaluation creates new Formula Module instances and executes Module-level
`let` initializers again.
