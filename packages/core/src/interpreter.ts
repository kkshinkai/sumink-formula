import type { Expression } from "./ast.js";
import { sortDiagnostics, type Diagnostic } from "./diagnostic.js";
import {
  evaluateExpression,
  type EvaluateOptions,
  type EvaluationResult,
} from "./evaluator.js";
import { lowerExpression } from "./lower.js";
import {
  compileLinkedProgram,
  type LinkedProgramAnalysis,
  type LinkEnvironment,
} from "./module-system.js";
import { parseExpression, type ParseResult } from "./parser.js";
import {
  resolveExpression,
  type Resolution,
  type ResolveOptions,
} from "./resolver.js";

export type AnalysisResult = LinkedProgramAnalysis;

export interface InterpretationResult {
  readonly analysis: AnalysisResult;
  readonly evaluation: EvaluationResult;
}

export interface ExpressionAnalysisResult {
  readonly parseResult: ParseResult;
  readonly expression: Expression;
  readonly resolution: Resolution;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExpressionInterpretationResult {
  readonly analysis: ExpressionAnalysisResult;
  readonly evaluation: EvaluationResult;
}

export function analyze(source: string, resolveOptions: ResolveOptions = {}): AnalysisResult {
  return compileLinkedProgram(source, linkEnvironment(resolveOptions)).analysis;
}

export function analyzeExpression(
  source: string,
  resolveOptions: ResolveOptions = {},
): ExpressionAnalysisResult {
  const parseResult = parseExpression(source);
  const lowerResult = lowerExpression(parseResult);
  const resolution = resolveExpression(lowerResult.expression, resolveOptions);
  return {
    parseResult,
    expression: lowerResult.expression,
    resolution,
    diagnostics: sortDiagnostics([...lowerResult.diagnostics, ...resolution.diagnostics]),
  };
}

export function interpret(source: string, options: EvaluateOptions = {}): InterpretationResult {
  const linked = compileLinkedProgram(source, linkEnvironment());
  const analysis = linked.analysis;
  const frontEndDiagnostic = analysis.diagnostics.find((entry) => entry.category === "error");
  return {
    analysis,
    evaluation: frontEndDiagnostic === undefined
      ? linked.evaluate(normalizeGlobals(options.globals), {
          ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
          ...(options.maxCallDepth === undefined ? {} : { maxCallDepth: options.maxCallDepth }),
        })
      : { ok: false, diagnostic: frontEndDiagnostic, usedDependencies: new Set() },
  };
}

function linkEnvironment(options: ResolveOptions = {}): LinkEnvironment {
  return {
    ...(options.externalBindings === undefined
      ? {}
      : { externalBindings: options.externalBindings }),
    nativeModules: options.importedModules ?? new Map(),
    ...(options.importedValues === undefined
      ? {}
      : { entryImportedValues: options.importedValues }),
  };
}

function normalizeGlobals(
  globals: EvaluateOptions["globals"],
): ReadonlyMap<string, import("./runtime-value.js").RuntimeValue> {
  if (globals === undefined) {
    return new Map();
  }
  return globals instanceof Map ? new Map(globals) : new Map(Object.entries(globals));
}

export function interpretExpression(
  source: string,
  options: EvaluateOptions = {},
): ExpressionInterpretationResult {
  const analysis = analyzeExpression(source);
  const frontEndDiagnostic = analysis.diagnostics.find((entry) => entry.category === "error");
  return {
    analysis,
    evaluation: frontEndDiagnostic === undefined
      ? evaluateExpression(analysis.expression, analysis.resolution, options)
      : { ok: false, diagnostic: frontEndDiagnostic, usedDependencies: new Set() },
  };
}
