export type Command = RunCommand | HelpCommand;

export interface RunCommand {
  readonly kind: "run";
  readonly file: string;
}

export interface HelpCommand {
  readonly kind: "help";
}

export interface CommandLineDiagnostic {
  readonly message: string;
}

export type ParseCommandLineResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly diagnostics: readonly CommandLineDiagnostic[] };

/** Parses the complete v1 command line without performing I/O or mutating process state. */
export function parseCommandLine(arguments_: readonly string[]): ParseCommandLineResult {
  const diagnostics: CommandLineDiagnostic[] = [];
  const files: string[] = [];
  let help = false;
  let parseOptions = true;

  for (const argument of arguments_) {
    if (parseOptions && argument === "--") {
      parseOptions = false;
    } else if (parseOptions && (argument === "--help" || argument === "-h")) {
      help = true;
    } else if (parseOptions && argument.startsWith("-")) {
      diagnostics.push({ message: `Unknown option '${argument}'.` });
    } else {
      files.push(argument);
    }
  }

  if (help) {
    if (files.length > 0) {
      diagnostics.push({ message: "The help option cannot be combined with a source file." });
    }
    if (diagnostics.length === 0) {
      return { ok: true, command: { kind: "help" } };
    }
    return { ok: false, diagnostics };
  }

  if (files.length === 0) {
    diagnostics.push({ message: "Expected one .sumi source file." });
  } else if (files.length > 1) {
    diagnostics.push({ message: `Expected one source file, but received ${files.length}.` });
  }

  return diagnostics.length === 0
    ? { ok: true, command: { kind: "run", file: files[0] ?? "" } }
    : { ok: false, diagnostics };
}
