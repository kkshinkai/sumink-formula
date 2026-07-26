import type { Program } from "./ast.js";
import { sortDiagnostics, type Diagnostic } from "./diagnostic.js";
import { evaluate, type EvaluateOptions, type EvaluationResult } from "./evaluator.js";
import { lower } from "./lower.js";
import { parse, type ParseResult } from "./parser.js";
import { resolve, type Resolution } from "./resolver.js";

export interface AnalysisResult {
  readonly parseResult: ParseResult;
  readonly program: Program;
  readonly resolution: Resolution;
  readonly diagnostics: readonly Diagnostic[];
}

export interface InterpretationResult {
  readonly analysis: AnalysisResult;
  readonly evaluation: EvaluationResult;
}

export function analyze(source: string): AnalysisResult {
  const parseResult = parse(source);
  const lowerResult = lower(parseResult);
  const resolution = resolve(lowerResult.program);
  return {
    parseResult,
    program: lowerResult.program,
    resolution,
    diagnostics: sortDiagnostics([...lowerResult.diagnostics, ...resolution.diagnostics]),
  };
}

export function interpret(source: string, options: EvaluateOptions = {}): InterpretationResult {
  const analysis = analyze(source);
  const frontEndDiagnostic = analysis.diagnostics.find((entry) => entry.category === "error");
  return {
    analysis,
    evaluation: frontEndDiagnostic === undefined
      ? evaluate(analysis.program, analysis.resolution, options)
      : { ok: false, diagnostic: frontEndDiagnostic, usedDependencies: new Set() },
  };
}
