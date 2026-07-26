import type { TextRange } from "./text.js";

export type DiagnosticCategory = "error" | "warning";
export type DiagnosticPhase = "lex" | "parse" | "resolve" | "evaluate";
export type DiagnosticCode =
  | "SF1000" | "SF1001" | "SF1002" | "SF1003" | "SF1004" | "SF1005" | "SF1006" | "SF1007"
  | "SF2000" | "SF2001" | "SF2002" | "SF2003" | "SF2004" | "SF2005" | "SF2006" | "SF2007" | "SF2008" | "SF2009"
  | "SF3000"
  | "SF4000" | "SF4001" | "SF4002" | "SF4003" | "SF4004" | "SF4005" | "SF4006"
  | "SF4007" | "SF4008" | "SF4009" | "SF4010" | "SF4011" | "SF4012" | "SF4013"
  | "SF4014" | "SF4015" | "SF4016" | "SF4017" | "SF4018" | "SF4019" | "SF4020"
  | "SF4021" | "SF4022" | "SF4023" | "SF4024" | "SF4025" | "SF4026" | "SF4027"
  | "SF4998" | "SF4999";

export interface RelatedDiagnosticInformation {
  readonly message: string;
  readonly range: TextRange;
}

/** A stable, serializable language diagnostic. */
export interface Diagnostic {
  /** Stable machine-readable identifier, for example `SF1001`. */
  readonly code: DiagnosticCode;
  readonly category: DiagnosticCategory;
  readonly phase: DiagnosticPhase;
  readonly message: string;
  readonly range: TextRange;
  readonly relatedInformation?: readonly RelatedDiagnosticInformation[];
}

export function diagnostic(
  code: DiagnosticCode,
  phase: DiagnosticPhase,
  message: string,
  range: TextRange,
  relatedInformation?: readonly RelatedDiagnosticInformation[],
): Diagnostic {
  return relatedInformation === undefined
    ? { code, category: "error", phase, message, range }
    : { code, category: "error", phase, message, range, relatedInformation };
}

export function sortDiagnostics(values: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...values].sort((left, right) =>
    left.range.start - right.range.start
    || left.range.end - right.range.end
    || phaseOrder(left.phase) - phaseOrder(right.phase)
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function phaseOrder(phase: DiagnosticPhase): number {
  switch (phase) {
    case "lex":
      return 0;
    case "parse":
      return 1;
    case "resolve":
      return 2;
    case "evaluate":
      return 3;
  }
}
