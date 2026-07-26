import { interpret, nativeFunction, SourceText } from "@sumink-formula/core";

import { parseCommandLine } from "./command-line.js";
import { formatCliError, formatDiagnostic } from "./format-diagnostic.js";
import { formatPrintValue } from "./format-value.js";

export const enum ExitStatus {
  Success,
  ProgramError,
  UsageError,
  InternalError,
}

export interface CliHost {
  readonly stderrIsTTY: boolean;
  readonly readFile: (path: string) => string;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly getEnvironmentVariable: (name: string) => string | undefined;
}

export const helpText = [
  "Usage: sumi [--] <file.sumi>",
  "",
  "Run a .sumi source file.",
  "",
  "Options:",
  "  -h, --help  Show this help.",
  "",
].join("\n");

export function runCli(arguments_: readonly string[], host: CliHost): ExitStatus {
  try {
    const color = shouldUseColor(host);
    const parsed = parseCommandLine(arguments_);
    if (!parsed.ok) {
      for (const diagnostic of parsed.diagnostics) {
        host.writeStderr(formatCliError(diagnostic.message, color));
      }
      host.writeStderr(`\n${helpText}`);
      return ExitStatus.UsageError;
    }

    if (parsed.command.kind === "help") {
      host.writeStdout(helpText);
      return ExitStatus.Success;
    }

    return runFile(parsed.command.file, host, color);
  } catch (error: unknown) {
    host.writeStderr(`Internal CLI error: ${describeError(error)}\n`);
    return ExitStatus.InternalError;
  }
}

function runFile(file: string, host: CliHost, color: boolean): ExitStatus {
  let source: string;
  try {
    source = host.readFile(file);
  } catch (error: unknown) {
    host.writeStderr(formatCliError(`Cannot read '${file}': ${describeError(error)}`, color));
    return ExitStatus.ProgramError;
  }

  const print = nativeFunction(({ arguments: [value = null] }) => {
    host.writeStdout(`${formatPrintValue(value)}\n`);
    return null;
  }, { name: "print", arity: 1 });
  const result = interpret(source, { globals: { print } });
  const sourceText = new SourceText(source);
  const formatOptions = { color, file, source: sourceText };

  if (result.analysis.diagnostics.length > 0) {
    for (const diagnostic of result.analysis.diagnostics) {
      host.writeStderr(formatDiagnostic(diagnostic, formatOptions));
    }
  }
  if (result.analysis.diagnostics.some((diagnostic) => diagnostic.category === "error")) {
    return ExitStatus.ProgramError;
  }
  if (!result.evaluation.ok) {
    host.writeStderr(formatDiagnostic(result.evaluation.diagnostic, formatOptions));
    return ExitStatus.ProgramError;
  }
  return ExitStatus.Success;
}

function shouldUseColor(host: CliHost): boolean {
  if (host.getEnvironmentVariable("NO_COLOR") !== undefined) {
    return false;
  }
  if (host.getEnvironmentVariable("FORCE_COLOR") !== undefined) {
    return true;
  }
  return host.stderrIsTTY;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
