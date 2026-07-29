import {
  defineEnvironment,
  hostFunction,
  SourceText,
  type FileModuleLoader,
} from "@sumink-formula/core";

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
  readonly resolvePath: (specifier: string, referrer?: string) => string;
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
  let sourceName: string;
  let source: string;
  try {
    sourceName = host.resolvePath(file);
    source = host.readFile(sourceName);
  } catch (error: unknown) {
    host.writeStderr(formatCliError(`Cannot read '${file}': ${describeError(error)}`, color));
    return ExitStatus.ProgramError;
  }

  const loadedSources = new Map<string, SourceText>([[sourceName, new SourceText(source)]]);
  const fileModuleLoader: FileModuleLoader = {
    load(specifier, referrer) {
      try {
        const name = host.resolvePath(specifier, referrer.name);
        const text = host.readFile(name);
        loadedSources.set(name, new SourceText(text));
        return { ok: true, source: { name, text } };
      } catch (error: unknown) {
        return { ok: false, message: describeError(error) };
      }
    },
  };
  const environment = defineEnvironment({
    print: hostFunction({
      parameters: ["value"],
      invoke: ({ arguments: [value = null] }) => {
        host.writeStdout(`${formatPrintValue(value)}\n`);
        return null;
      },
    }),
  });
  const compilation = environment.compileProgram(source, { sourceName, fileModuleLoader });
  const sources = compilation.ok
    ? compilation.program.analysis.sources
    : compilation.sources ?? loadedSources;
  const formatOptions = { color, fallbackSourceName: sourceName, sources };

  if (!compilation.ok) {
    for (const diagnostic of compilation.diagnostics) {
      host.writeStderr(formatDiagnostic(diagnostic, formatOptions));
    }
    return ExitStatus.ProgramError;
  }
  const evaluation = compilation.program.evaluate(environment.createActivation({}));
  if (!evaluation.ok) {
    host.writeStderr(formatDiagnostic(evaluation.diagnostic, formatOptions));
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
