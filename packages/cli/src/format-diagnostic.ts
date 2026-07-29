import { SourceText, type Diagnostic, type RelatedDiagnosticInformation } from "@sumink-formula/core";

const ansiRed = "\u001b[31m";
const ansiReset = "\u001b[0m";

export interface DiagnosticFormatOptions {
  readonly color: boolean;
  readonly fallbackSourceName: string;
  readonly sources: ReadonlyMap<string, SourceText>;
}

export function formatDiagnostic(
  diagnostic: Diagnostic,
  options: DiagnosticFormatOptions,
): string {
  const lines = [formatPrimaryDiagnostic(diagnostic, options)];
  for (const related of diagnostic.relatedInformation ?? []) {
    lines.push(formatRelatedDiagnostic(related, options));
  }
  return `${lines.join("\n")}\n`;
}

export function formatCliError(message: string, color: boolean): string {
  return `${formatLabel("error", color)}: ${message}\n`;
}

function formatPrimaryDiagnostic(
  diagnostic: Diagnostic,
  options: DiagnosticFormatOptions,
): string {
  const sourceName = diagnostic.sourceName ?? options.fallbackSourceName;
  const source = options.sources.get(sourceName) ?? new SourceText("");
  const position = source.positionAt(diagnostic.range.start);
  return `${sourceName}:${position.line + 1}:${position.column + 1} - `
    + `${formatLabel(diagnostic.category, options.color)} ${diagnostic.code}: ${diagnostic.message}`;
}

function formatRelatedDiagnostic(
  related: RelatedDiagnosticInformation,
  options: DiagnosticFormatOptions,
): string {
  const sourceName = related.sourceName ?? options.fallbackSourceName;
  const source = options.sources.get(sourceName) ?? new SourceText("");
  const position = source.positionAt(related.range.start);
  return `${sourceName}:${position.line + 1}:${position.column + 1} - note: ${related.message}`;
}

function formatLabel(label: string, color: boolean): string {
  return color ? `${ansiRed}${label}${ansiReset}` : label;
}
