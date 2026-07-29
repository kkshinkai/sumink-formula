import type {
  ExportDeclaration,
  FileModule,
  FnStatement,
  ImportDeclaration,
  ImportSelector,
  LetStatement,
  ModuleDeclaration,
  ModuleItem,
  ModulePath,
  Program,
  ProgramItem,
  Statement,
} from "./ast.js";
import { diagnostic, type Diagnostic } from "./diagnostic.js";
import {
  evaluate,
  evaluateModule,
  type EvaluateOptions,
  type EvaluationResult,
} from "./evaluator.js";
import { lower, lowerFileModule } from "./lower.js";
import { parse, parseFileModule, type ParseResult } from "./parser.js";
import {
  resolve,
  type BindingId,
  type ExternalBindingResolution,
  type Resolution,
  type ResolvedModuleBinding,
  type ResolvedModuleMember,
} from "./resolver.js";
import type { RuntimeValue } from "./runtime-value.js";
import { SourceText, type TextRange } from "./text.js";

export interface SourceUnit {
  /** Canonical identity and diagnostic name within one compilation. */
  readonly name: string;
  readonly text: string;
}

export type FileModuleLoadResult =
  | { readonly ok: true; readonly source: SourceUnit }
  | { readonly ok: false; readonly message: string };

export interface FileModuleLoader {
  load(specifier: string, referrer: SourceUnit): FileModuleLoadResult;
}

export interface ProgramCompileOptions {
  readonly sourceName?: string;
  readonly fileModuleLoader?: FileModuleLoader;
}

export interface LinkedProgramAnalysis {
  readonly entry: SourceUnit;
  readonly parseResult: ParseResult;
  readonly program: Program;
  readonly resolution: Resolution;
  readonly diagnostics: readonly Diagnostic[];
  readonly sources: ReadonlyMap<string, SourceText>;
  readonly freeNames: ReadonlySet<string>;
  readonly dependencies: ReadonlySet<string>;
}

export interface LinkedProgram {
  readonly analysis: LinkedProgramAnalysis;
  evaluate(
    globals: ReadonlyMap<string, RuntimeValue>,
    options?: Omit<EvaluateOptions, "globals" | "dependencySink">,
  ): EvaluationResult;
}

export interface LinkEnvironment {
  readonly externalBindings?: ReadonlySet<string>;
  readonly nativeModules: ReadonlyMap<string, ResolvedModuleBinding>;
  readonly inputNames?: ReadonlySet<string>;
  readonly entryImportedValues?: ReadonlyMap<string, ExternalBindingResolution>;
}

type FormulaRoot = Program | FileModule | ModuleDeclaration;

interface FormulaModuleRecord {
  readonly id: number;
  readonly kind: "program" | "module";
  readonly source: SourceUnit;
  readonly root: FormulaRoot;
  readonly displayName: string;
  readonly container?: FormulaModuleRecord;
  readonly children: Map<string, FormulaModuleRecord>;
  readonly fileTargets: Map<number, FormulaModuleRecord>;
  readonly moduleBinding?: MutableModuleBinding;
  readonly importedValues: Map<string, ExternalBindingResolution>;
  readonly importedModules: Map<string, ResolvedModuleBinding>;
  readonly dependencies: Set<FormulaModuleRecord>;
  readonly localExportDeclarations: Map<string, LetStatement | FnStatement>;
  readonly localExportBindings: Map<string, BindingId>;
  resolution?: Resolution;
  linkState: "unlinked" | "linking" | "linked";
}

interface MutableModuleBinding extends ResolvedModuleBinding {
  readonly exports: Map<string, ResolvedModuleMember>;
}

interface ImportCandidate {
  readonly member: ResolvedModuleMember;
  readonly priority: 1 | 2;
  readonly range: TextRange;
  readonly sourceName: string;
}

interface ExportCandidate extends ImportCandidate {
  readonly exportedName: string;
}

interface RuntimeModuleState {
  readonly values: Map<string, RuntimeValue>;
  readonly initialized: Set<FormulaModuleRecord>;
  readonly dependencies: Set<string>;
}

export function compileLinkedProgram(
  source: string,
  environment: LinkEnvironment,
  options: ProgramCompileOptions = {},
): LinkedProgram {
  return new ModuleGraphBuilder(environment, options).compile(source);
}

class ModuleGraphBuilder {
  readonly #environment: LinkEnvironment;
  readonly #loader: FileModuleLoader | undefined;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #sources = new Map<string, SourceText>();
  readonly #sourceTexts = new Map<string, string>();
  readonly #fileRecords = new Map<string, FormulaModuleRecord>();
  readonly #invalidFileSources = new Set<string>();
  readonly #loadRequests = new Map<string, FormulaModuleRecord | undefined>();
  readonly #recordByBinding = new WeakMap<ResolvedModuleBinding, FormulaModuleRecord>();
  readonly #runtimeOwners = new Map<string, FormulaModuleRecord>();
  #nextRecordId = 0;

  public constructor(environment: LinkEnvironment, options: ProgramCompileOptions) {
    this.#environment = environment;
    this.#loader = options.fileModuleLoader;
    this.#entryName = options.sourceName ?? "<program>";
  }

  readonly #entryName: string;

  public compile(source: string): LinkedProgram {
    const entrySource = Object.freeze({ name: this.#entryName, text: source });
    this.#rememberSource(entrySource);
    const parseResult = parse(source);
    const lowerResult = lower(parseResult);
    this.#addDiagnostics(lowerResult.diagnostics, entrySource.name);
    const entry = this.#createRecord("program", entrySource, lowerResult.program, "<program>");

    if (!hasErrors(this.#diagnostics)) {
      this.#collectRecord(entry);
      this.#linkRecord(entry, entry.root.range, entry.source.name);
    }

    const resolution = entry.resolution ?? resolve(lowerResult.program, {
      ...(this.#environment.externalBindings === undefined
        ? {}
        : { externalBindings: this.#environment.externalBindings }),
    });
    if (entry.resolution === undefined) {
      this.#addDiagnostics(resolution.diagnostics, entrySource.name);
    }
    const freeNames = new Set<string>();
    const dependencies = new Set<string>();
    for (const record of this.#allRecords(entry)) {
      for (const reference of record.resolution?.references.values() ?? []) {
        if (reference.kind === "external" && !reference.name.startsWith("\u0000module:")) {
          freeNames.add(reference.name);
        }
      }
      for (const dependency of record.resolution?.dependencies ?? []) {
        if (
          this.#environment.inputNames === undefined
          || this.#environment.inputNames.has(dependency)
        ) {
          dependencies.add(dependency);
        }
      }
    }
    const diagnostics = this.#sortedDiagnostics();
    const analysis: LinkedProgramAnalysis = Object.freeze({
      entry: entrySource,
      parseResult,
      program: lowerResult.program,
      resolution,
      diagnostics,
      sources: new Map(this.#sources),
      freeNames,
      dependencies,
    });
    return Object.freeze({
      analysis,
      evaluate: (
        globals: ReadonlyMap<string, RuntimeValue>,
        evaluateOptions: Omit<EvaluateOptions, "globals" | "dependencySink"> = {},
      ) => this.#evaluate(entry, globals, evaluateOptions, analysis),
    });
  }

  #createRecord(
    kind: FormulaModuleRecord["kind"],
    source: SourceUnit,
    root: FormulaRoot,
    displayName: string,
    container?: FormulaModuleRecord,
  ): FormulaModuleRecord {
    const moduleBinding: MutableModuleBinding | undefined = kind === "module"
      ? { displayName, exports: new Map() }
      : undefined;
    const record: FormulaModuleRecord = {
      id: this.#nextRecordId,
      kind,
      source,
      root,
      displayName,
      ...(container === undefined ? {} : { container }),
      children: new Map(),
      fileTargets: new Map(),
      ...(moduleBinding === undefined ? {} : { moduleBinding }),
      importedValues: new Map(),
      importedModules: new Map(),
      dependencies: new Set(),
      localExportDeclarations: new Map(),
      localExportBindings: new Map(),
      linkState: "unlinked",
    };
    this.#nextRecordId += 1;
    if (moduleBinding !== undefined) {
      this.#recordByBinding.set(moduleBinding, record);
    }
    return record;
  }

  #collectRecord(record: FormulaModuleRecord): void {
    const items = rootItems(record.root);
    for (const declaration of moduleDeclarations(items)) {
      const displayName = `${record.displayName}.${declaration.name}`;
      const child = this.#createRecord("module", record.source, declaration, displayName, record);
      const previous = record.children.get(declaration.name);
      if (previous !== undefined) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3106",
          "link",
          `Duplicate module declaration '${declaration.name}'.`,
          declaration.nameRange,
          record.source.name,
          [{
            message: "The first module declaration is here.",
            range: moduleNameRange(previous.root),
            sourceName: previous.source.name,
          }],
        ));
      } else {
        record.children.set(declaration.name, child);
      }
      this.#collectRecord(child);
    }

    for (const declaration of imports(items)) {
      if (declaration.source === undefined) {
        continue;
      }
      const target = this.#loadFileModule(declaration, record);
      if (target !== undefined) {
        record.fileTargets.set(declaration.id, target);
      }
    }
  }

  #loadFileModule(
    declaration: ImportDeclaration,
    referrer: FormulaModuleRecord,
  ): FormulaModuleRecord | undefined {
    const specifier = declaration.source ?? "";
    const requestKey = `${referrer.source.name}\u0000${specifier}`;
    if (this.#loadRequests.has(requestKey)) {
      return this.#loadRequests.get(requestKey);
    }
    if (this.#loader === undefined) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3101",
        "load",
        `Cannot load '${specifier}' because no File Module loader was provided.`,
        declaration.sourceRange ?? declaration.range,
        referrer.source.name,
      ));
      this.#loadRequests.set(requestKey, undefined);
      return undefined;
    }

    let result: FileModuleLoadResult;
    try {
      result = normalizeLoadResult(this.#loader.load(specifier, referrer.source));
    } catch (error: unknown) {
      result = { ok: false, message: describeError(error) };
    }
    if (!result.ok) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3101",
        "load",
        `Cannot load '${specifier}': ${result.message}`,
        declaration.sourceRange ?? declaration.range,
        referrer.source.name,
      ));
      this.#loadRequests.set(requestKey, undefined);
      return undefined;
    }

    const loaded = Object.freeze({ name: result.source.name, text: result.source.text });
    const previousText = this.#sourceTexts.get(loaded.name);
    if (previousText !== undefined && previousText !== loaded.text) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3107",
        "load",
        `File Module '${loaded.name}' was loaded with inconsistent source text.`,
        declaration.sourceRange ?? declaration.range,
        referrer.source.name,
      ));
      this.#loadRequests.set(requestKey, undefined);
      return undefined;
    }
    const existing = this.#fileRecords.get(loaded.name);
    if (existing !== undefined) {
      const reusable = this.#invalidFileSources.has(loaded.name) ? undefined : existing;
      this.#loadRequests.set(requestKey, reusable);
      return reusable;
    }

    this.#rememberSource(loaded);
    const parseResult = parseFileModule(loaded.text);
    const lowerResult = lowerFileModule(parseResult);
    this.#addDiagnostics(lowerResult.diagnostics, loaded.name);
    const record = this.#createRecord("module", loaded, lowerResult.fileModule, loaded.name);
    this.#fileRecords.set(loaded.name, record);
    if (hasErrors(lowerResult.diagnostics)) {
      this.#invalidFileSources.add(loaded.name);
      this.#loadRequests.set(requestKey, undefined);
      return undefined;
    }
    this.#loadRequests.set(requestKey, record);
    this.#collectRecord(record);
    return record;
  }

  #linkRecord(
    record: FormulaModuleRecord,
    edgeRange: TextRange,
    edgeSourceName: string,
  ): void {
    if (record.linkState === "linked") {
      return;
    }
    if (record.linkState === "linking") {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3102",
        "link",
        `Module cycle reaches '${record.displayName}'.`,
        edgeRange,
        edgeSourceName,
      ));
      return;
    }
    record.linkState = "linking";

    this.#validateLocalDeclarations(record);
    this.#collectDirectExports(record);
    for (const child of record.children.values()) {
      this.#linkRecord(child, moduleNameRange(child.root), child.source.name);
    }
    const importCandidates = new Map<string, ImportCandidate[]>();

    const aliasImports = imports(rootItems(record.root)).filter(
      (declaration): declaration is ImportDeclaration & {
        readonly clause: Extract<ImportDeclaration["clause"], {
          readonly kind: "ModuleAliasImportClause";
        }>;
      } => declaration.clause.kind === "ModuleAliasImportClause",
    );
    for (const declaration of aliasImports) {
      if (declaration.source === undefined) {
        continue;
      }
      if ((declaration.modulePath?.segments.length ?? 0) !== 1) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3105",
          "link",
          "A File Module alias must be a single identifier.",
          declaration.modulePath?.range ?? declaration.range,
          record.source.name,
        ));
        continue;
      }
      const target = record.fileTargets.get(declaration.id);
      if (target === undefined || target.moduleBinding === undefined) {
        continue;
      }
      this.#linkDependency(record, target, declaration.range);
      this.#addModuleImport(
        record,
        declaration.clause.localName,
        target.moduleBinding,
        declaration.clause.localNameRange,
      );
    }

    const unresolvedAliases = aliasImports.filter((declaration) => declaration.source === undefined);
    let pending: typeof aliasImports = unresolvedAliases;
    while (pending.length > 0) {
      const next: typeof aliasImports = [];
      let progress = false;
      for (const declaration of pending) {
        const target = declaration.modulePath === undefined
          ? undefined
          : this.#resolveModulePath(record, declaration.modulePath, false);
        if (target === undefined) {
          next.push(declaration);
          continue;
        }
        this.#linkModuleBinding(record, target, declaration.range);
        this.#addModuleImport(
          record,
          declaration.clause.kind === "ModuleAliasImportClause"
            ? declaration.clause.localName
            : "",
          target,
          declaration.clause.kind === "ModuleAliasImportClause"
            ? declaration.clause.localNameRange
            : declaration.range,
        );
        progress = true;
      }
      if (!progress) {
        pending = next;
        break;
      }
      pending = next;
    }
    for (const declaration of pending) {
      if (declaration.modulePath !== undefined) {
        this.#resolveModulePath(record, declaration.modulePath, true);
      }
    }

    for (const declaration of imports(rootItems(record.root))) {
      if (declaration.clause.kind !== "MemberImportClause") {
        continue;
      }
      const target = declaration.source === undefined
        ? declaration.modulePath === undefined
          ? undefined
          : this.#resolveModulePath(record, declaration.modulePath, true)
        : record.fileTargets.get(declaration.id)?.moduleBinding;
      if (target === undefined) {
        continue;
      }
      this.#linkModuleBinding(record, target, declaration.range);
      this.#collectSelectorCandidates(
        target,
        declaration.clause.selectors,
        declaration.sourceRange ?? declaration.range,
        record.source.name,
        importCandidates,
      );
    }
    this.#finalizeImports(record, importCandidates);

    this.#collectSelectorExports(record);
    this.#resolveRecord(record);
    record.linkState = "linked";
  }

  #validateLocalDeclarations(record: FormulaModuleRecord): void {
    const seen = new Map<string, { range: TextRange; sourceName: string }>();
    for (const [name, child] of record.children) {
      seen.set(name, { range: moduleNameRange(child.root), sourceName: child.source.name });
    }
    for (const statement of runtimeStatements(record.root)) {
      if (statement.kind === "ExpressionStatement") {
        continue;
      }
      const entry = declarationName(statement);
      if (entry === undefined) {
        continue;
      }
      const previous = seen.get(entry.name);
      if (previous !== undefined) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3106",
          "link",
          `Duplicate declaration '${entry.name}' in the same module scope.`,
          entry.range,
          record.source.name,
          [{ message: "The first declaration is here.", ...previous }],
        ));
      }
    }
  }

  #collectDirectExports(record: FormulaModuleRecord): void {
    if (record.moduleBinding === undefined) {
      return;
    }
    for (const item of rootItems(record.root)) {
      if (item.kind !== "ExportDeclaration" || item.declaration === undefined) {
        continue;
      }
      const declaration = item.declaration;
      if (declaration.kind === "ModuleDeclaration") {
        const child = record.children.get(declaration.name);
        if (child?.moduleBinding !== undefined) {
          this.#setExplicitExport(
            record,
            declaration.name,
            { kind: "module", module: child.moduleBinding },
            declaration.nameRange,
          );
        }
        continue;
      }
      const name = declarationName(declaration);
      if (name === undefined) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3106",
          "link",
          "An exported let declaration must bind an identifier.",
          declaration.range,
          record.source.name,
        ));
        continue;
      }
      record.localExportDeclarations.set(name.name, declaration);
      this.#setExplicitExport(
        record,
        name.name,
        { kind: "value", binding: this.#formulaExportBinding(record, name.name) },
        name.range,
      );
    }
  }

  #collectSelectorExports(record: FormulaModuleRecord): void {
    if (record.moduleBinding === undefined) {
      return;
    }
    const candidates = new Map<string, ExportCandidate[]>();
    for (const item of rootItems(record.root)) {
      if (
        item.kind !== "ExportDeclaration"
        || item.modulePath === undefined
        || item.selectors === undefined
      ) {
        continue;
      }
      const target = this.#resolveModulePath(record, item.modulePath, true);
      if (target === undefined) {
        continue;
      }
      this.#linkModuleBinding(record, target, item.range);
      const selected = new Map<string, ImportCandidate[]>();
      this.#collectSelectorCandidates(
        target,
        item.selectors,
        item.range,
        record.source.name,
        selected,
      );
      for (const [name, values] of selected) {
        const destination = candidates.get(name) ?? [];
        destination.push(...values.map((value) => ({ ...value, exportedName: name })));
        candidates.set(name, destination);
      }
    }

    for (const [name, values] of candidates) {
      const bestPriority = Math.max(...values.map((candidate) => candidate.priority));
      const best = values.filter((candidate) => candidate.priority === bestPriority);
      if (best.length > 1) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3106",
          "link",
          `Export '${name}' is provided by multiple modules.`,
          best[0]?.range ?? record.root.range,
          best[0]?.sourceName ?? record.source.name,
        ));
        continue;
      }
      const candidate = best[0];
      if (candidate === undefined) {
        continue;
      }
      const existing = record.moduleBinding.exports.get(name);
      if (existing !== undefined && candidate.priority === 2) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3106",
          "link",
          `Duplicate explicit export '${name}'.`,
          candidate.range,
          candidate.sourceName,
        ));
      } else if (existing === undefined) {
        record.moduleBinding.exports.set(name, candidate.member);
      }
    }
  }

  #collectSelectorCandidates(
    target: ResolvedModuleBinding,
    selectors: readonly ImportSelector[],
    range: TextRange,
    sourceName: string,
    candidates: Map<string, ImportCandidate[]>,
  ): void {
    if (selectors.length === 0) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3105",
        "link",
        "An import or export selector list cannot be empty.",
        range,
        sourceName,
      ));
      return;
    }
    const wildcardIndexes = selectors.flatMap((selector, index) =>
      selector.kind === "WildcardImportSelector" ? [index] : []
    );
    if (wildcardIndexes.length > 1) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3105",
        "link",
        "An import or export selector list can contain at most one wildcard.",
        range,
        sourceName,
      ));
    }
    const wildcardIndex = wildcardIndexes[0];
    if (wildcardIndex !== undefined && wildcardIndex !== selectors.length - 1) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3105",
        "link",
        "The wildcard selector must be last.",
        selectors[wildcardIndex]?.range ?? range,
        sourceName,
      ));
    }
    const excluded = new Set<string>();
    for (const selector of selectors) {
      if (selector.kind === "WildcardImportSelector") {
        continue;
      }
      if (selector.excluded) {
        excluded.add(selector.importedName);
        if (!target.exports.has(selector.importedName)) {
          this.#diagnostics.push(this.#sourceDiagnostic(
            "SF3103",
            "link",
            `Module '${target.displayName}' has no export named '${selector.importedName}'.`,
            selector.importedNameRange,
            sourceName,
          ));
        }
        if (wildcardIndex === undefined) {
          this.#diagnostics.push(this.#sourceDiagnostic(
            "SF3105",
            "link",
            `Exclusion '${selector.importedName} as _' requires a wildcard selector.`,
            selector.range,
            sourceName,
          ));
        }
        continue;
      }
      excluded.add(selector.importedName);
      const member = target.exports.get(selector.importedName);
      if (member === undefined) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3103",
          "link",
          `Module '${target.displayName}' has no export named '${selector.importedName}'.`,
          selector.importedNameRange,
          sourceName,
        ));
        continue;
      }
      const localName = selector.localName ?? selector.importedName;
      pushCandidate(candidates, localName, {
        member,
        priority: 2,
        range: selector.localNameRange ?? selector.importedNameRange,
        sourceName,
      });
    }
    if (wildcardIndex !== undefined) {
      for (const [name, member] of target.exports) {
        if (!excluded.has(name)) {
          pushCandidate(candidates, name, { member, priority: 1, range, sourceName });
        }
      }
    }
  }

  #finalizeImports(
    record: FormulaModuleRecord,
    candidates: ReadonlyMap<string, readonly ImportCandidate[]>,
  ): void {
    for (const [name, values] of candidates) {
      const bestPriority = Math.max(...values.map((candidate) => candidate.priority));
      const best = values.filter((candidate) => candidate.priority === bestPriority);
      if (best.length > 1) {
        this.#diagnostics.push(this.#sourceDiagnostic(
          "SF3105",
          "link",
          `Import '${name}' is ambiguous.`,
          best[0]?.range ?? record.root.range,
          best[0]?.sourceName ?? record.source.name,
        ));
        continue;
      }
      const candidate = best[0];
      if (candidate === undefined) {
        continue;
      }
      if (candidate.member.kind === "module") {
        this.#linkModuleBinding(record, candidate.member.module, candidate.range);
        this.#addModuleImport(record, name, candidate.member.module, candidate.range);
      } else {
        const existingModule = record.importedModules.get(name);
        if (existingModule !== undefined) {
          this.#diagnostics.push(this.#sourceDiagnostic(
            "SF3105",
            "link",
            `Import '${name}' names both a value and a module.`,
            candidate.range,
            candidate.sourceName,
          ));
        } else {
          record.importedValues.set(name, candidate.member.binding);
        }
      }
    }
  }

  #addModuleImport(
    record: FormulaModuleRecord,
    name: string,
    module: ResolvedModuleBinding,
    range: TextRange,
  ): void {
    const value = record.importedValues.get(name);
    const existing = record.importedModules.get(name);
    if (value !== undefined || existing !== undefined) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3105",
        "link",
        `Import '${name}' is ambiguous.`,
        range,
        record.source.name,
      ));
      return;
    }
    record.importedModules.set(name, module);
  }

  #resolveModulePath(
    record: FormulaModuleRecord,
    path: ModulePath,
    report: boolean,
  ): ResolvedModuleBinding | undefined {
    const first = path.segments[0];
    if (first === undefined) {
      return undefined;
    }
    let module = record.children.get(first.name)?.moduleBinding
      ?? record.importedModules.get(first.name)
      ?? record.container?.children.get(first.name)?.moduleBinding
      ?? this.#environment.nativeModules.get(first.name);
    if (module === undefined) {
      if (report) {
        const valueNames = new Set(runtimeStatements(record.root).flatMap((statement) => {
          if (statement.kind === "ExpressionStatement") return [];
          const declaration = declarationName(statement);
          return declaration === undefined ? [] : [declaration.name];
        }));
        const isValue = valueNames.has(first.name) || record.importedValues.has(first.name);
        this.#diagnostics.push(this.#sourceDiagnostic(
          isValue ? "SF3104" : "SF3100",
          "link",
          isValue
            ? `'${first.name}' is a value, not a module.`
            : "Project module imports are not available.",
          first.range,
          record.source.name,
        ));
      }
      return undefined;
    }
    for (const segment of path.segments.slice(1)) {
      this.#linkModuleBinding(record, module, segment.range);
      const member = module.exports.get(segment.name);
      if (member === undefined) {
        if (report) {
          this.#diagnostics.push(this.#sourceDiagnostic(
            "SF3103",
            "link",
            `Module '${module.displayName}' has no export named '${segment.name}'.`,
            segment.range,
            record.source.name,
          ));
        }
        return undefined;
      }
      if (member.kind !== "module") {
        if (report) {
          this.#diagnostics.push(this.#sourceDiagnostic(
            "SF3104",
            "link",
            `Export '${segment.name}' is a value, not a module.`,
            segment.range,
            record.source.name,
          ));
        }
        return undefined;
      }
      module = member.module;
    }
    return module;
  }

  #linkModuleBinding(
    owner: FormulaModuleRecord,
    binding: ResolvedModuleBinding,
    range: TextRange,
  ): void {
    const target = this.#recordByBinding.get(binding);
    if (target !== undefined) {
      this.#linkDependency(owner, target, range);
    }
  }

  #linkDependency(
    owner: FormulaModuleRecord,
    target: FormulaModuleRecord,
    range: TextRange,
  ): void {
    owner.dependencies.add(target);
    this.#linkRecord(target, range, owner.source.name);
  }

  #resolveRecord(record: FormulaModuleRecord): void {
    const modules = new Map(record.importedModules);
    for (const [name, child] of record.children) {
      if (child.moduleBinding !== undefined) {
        modules.set(name, child.moduleBinding);
      }
    }
    const program = record.kind === "program"
      ? record.root as Program
      : moduleProgram(record.root as FileModule | ModuleDeclaration);
    const importedValues = record.kind === "program"
      ? new Map(this.#environment.entryImportedValues)
      : new Map<string, ExternalBindingResolution>();
    for (const [name, binding] of record.importedValues) {
      importedValues.set(name, binding);
    }
    const externalBindings = record.kind === "program"
      ? this.#environment.externalBindings
      : new Set<string>();
    record.resolution = resolve(program, {
      ...(externalBindings === undefined ? {} : { externalBindings }),
      importedValues,
      importedModules: modules,
    });
    this.#addDiagnostics(record.resolution.diagnostics, record.source.name);
    for (const reference of record.resolution.references.values()) {
      if (reference.kind !== "external") {
        continue;
      }
      const owner = this.#runtimeOwners.get(reference.name);
      if (owner !== undefined && owner !== record) {
        record.dependencies.add(owner);
      }
    }

    if (record.kind !== "module") {
      return;
    }
    for (const [name, declaration] of record.localExportDeclarations) {
      const bindingId = declaration.kind === "FnStatement"
        ? record.resolution.bindings.get(declaration.id)
        : record.resolution.bindings.get(declaration.pattern.id);
      if (bindingId !== undefined) {
        record.localExportBindings.set(name, bindingId);
      }
    }
  }

  #setExplicitExport(
    record: FormulaModuleRecord,
    name: string,
    member: ResolvedModuleMember,
    range: TextRange,
  ): void {
    const exports = record.moduleBinding?.exports;
    if (exports === undefined) {
      return;
    }
    if (exports.has(name)) {
      this.#diagnostics.push(this.#sourceDiagnostic(
        "SF3106",
        "link",
        `Duplicate explicit export '${name}'.`,
        range,
        record.source.name,
      ));
      return;
    }
    exports.set(name, member);
  }

  #formulaExportBinding(
    record: FormulaModuleRecord,
    exportName: string,
  ): ExternalBindingResolution {
    const runtimeName = `\u0000module:${record.id}:${exportName}`;
    this.#runtimeOwners.set(runtimeName, record);
    return {
      runtimeName,
      displayName: `${record.displayName}.${exportName}`,
    };
  }

  #evaluate(
    entry: FormulaModuleRecord,
    globals: ReadonlyMap<string, RuntimeValue>,
    options: Omit<EvaluateOptions, "globals" | "dependencySink">,
    analysis: LinkedProgramAnalysis,
  ): EvaluationResult {
    const frontEndError = analysis.diagnostics.find((entry_) => entry_.category === "error");
    if (frontEndError !== undefined) {
      return { ok: false, diagnostic: frontEndError, usedDependencies: new Set() };
    }
    const state: RuntimeModuleState = {
      values: new Map(globals),
      initialized: new Set(),
      dependencies: new Set(),
    };
    for (const dependency of entry.dependencies) {
      const error = this.#evaluateModuleRecord(dependency, state, options);
      if (error !== undefined) {
        return { ok: false, diagnostic: error, usedDependencies: state.dependencies };
      }
    }
    const result = evaluate(entry.root as Program, entry.resolution!, {
      ...options,
      globals: state.values,
      dependencySink: state.dependencies,
      sourceName: entry.source.name,
    });
    return result.ok
      ? { ...result, usedDependencies: state.dependencies }
      : {
          ...result,
          diagnostic: withSourceName(result.diagnostic, entry.source.name),
          usedDependencies: state.dependencies,
        };
  }

  #evaluateModuleRecord(
    record: FormulaModuleRecord,
    state: RuntimeModuleState,
    options: Omit<EvaluateOptions, "globals" | "dependencySink">,
  ): Diagnostic | undefined {
    if (state.initialized.has(record)) {
      return undefined;
    }
    for (const dependency of record.dependencies) {
      const error = this.#evaluateModuleRecord(dependency, state, options);
      if (error !== undefined) {
        return error;
      }
    }
    const result = evaluateModule(
      runtimeStatements(record.root),
      record.resolution!,
      record.localExportBindings,
      {
        ...options,
        globals: state.values,
        dependencySink: state.dependencies,
        sourceName: record.source.name,
      },
    );
    if (!result.ok) {
      return withSourceName(result.diagnostic, record.source.name);
    }
    for (const [name, value] of result.exports) {
      const member = record.moduleBinding?.exports.get(name);
      if (member?.kind === "value") {
        state.values.set(member.binding.runtimeName, value);
      }
    }
    state.initialized.add(record);
    return undefined;
  }

  #rememberSource(source: SourceUnit): void {
    this.#sourceTexts.set(source.name, source.text);
    this.#sources.set(source.name, new SourceText(source.text));
  }

  #addDiagnostics(values: readonly Diagnostic[], sourceName: string): void {
    this.#diagnostics.push(...values.map((value) => withSourceName(value, sourceName)));
  }

  #sourceDiagnostic(
    code: "SF3100" | "SF3101" | "SF3102" | "SF3103" | "SF3104" | "SF3105" | "SF3106" | "SF3107",
    phase: "load" | "link",
    message: string,
    range: TextRange,
    sourceName: string,
    relatedInformation?: Diagnostic["relatedInformation"],
  ): Diagnostic {
    return withSourceName(
      diagnostic(code, phase, message, range, relatedInformation),
      sourceName,
    );
  }

  #sortedDiagnostics(): readonly Diagnostic[] {
    const sourceOrder = new Map([...this.#sources.keys()].map((name, index) => [name, index]));
    return [...this.#diagnostics].sort((left, right) =>
      (sourceOrder.get(left.sourceName ?? "") ?? Number.MAX_SAFE_INTEGER)
        - (sourceOrder.get(right.sourceName ?? "") ?? Number.MAX_SAFE_INTEGER)
      || left.range.start - right.range.start
      || left.range.end - right.range.end
      || compareText(left.code, right.code)
      || compareText(left.message, right.message)
    );
  }

  #allRecords(entry: FormulaModuleRecord): readonly FormulaModuleRecord[] {
    const values: FormulaModuleRecord[] = [];
    const seen = new Set<FormulaModuleRecord>();
    const visit = (record: FormulaModuleRecord): void => {
      if (seen.has(record)) {
        return;
      }
      seen.add(record);
      values.push(record);
      record.children.forEach(visit);
      record.dependencies.forEach(visit);
    };
    visit(entry);
    return values;
  }
}

function rootItems(root: FormulaRoot): readonly (ProgramItem | ModuleItem)[] {
  return root.items;
}

function moduleDeclarations(
  items: readonly (ProgramItem | ModuleItem)[],
): readonly ModuleDeclaration[] {
  return items.flatMap((item) => {
    if (item.kind === "ModuleDeclaration") {
      return [item];
    }
    return item.kind === "ExportDeclaration" && item.declaration?.kind === "ModuleDeclaration"
      ? [item.declaration]
      : [];
  });
}

function imports(items: readonly (ProgramItem | ModuleItem)[]): readonly ImportDeclaration[] {
  return items.filter((item): item is ImportDeclaration => item.kind === "ImportDeclaration");
}

function runtimeStatements(root: FormulaRoot): readonly Statement[] {
  return root.items.flatMap((item): readonly Statement[] => {
    if (
      item.kind === "LetStatement"
      || item.kind === "FnStatement"
      || item.kind === "ExpressionStatement"
    ) {
      return [item];
    }
    if (
      item.kind === "ExportDeclaration"
      && item.declaration !== undefined
      && item.declaration.kind !== "ModuleDeclaration"
    ) {
      return [item.declaration];
    }
    return [];
  });
}

function moduleProgram(root: FileModule | ModuleDeclaration): Program {
  return {
    kind: "Program",
    id: root.id,
    range: root.range,
    items: runtimeStatements(root),
  };
}

function declarationName(
  declaration: LetStatement | FnStatement,
): { readonly name: string; readonly range: TextRange } | undefined {
  if (declaration.kind === "FnStatement") {
    return { name: declaration.name, range: declaration.nameRange };
  }
  return declaration.pattern.kind === "IdentifierPattern"
    ? { name: declaration.pattern.name, range: declaration.pattern.range }
    : undefined;
}

function moduleNameRange(root: FormulaRoot): TextRange {
  return root.kind === "ModuleDeclaration" ? root.nameRange : root.range;
}

function pushCandidate(
  candidates: Map<string, ImportCandidate[]>,
  name: string,
  candidate: ImportCandidate,
): void {
  const values = candidates.get(name) ?? [];
  values.push(candidate);
  candidates.set(name, values);
}

function withSourceName(value: Diagnostic, sourceName: string): Diagnostic {
  return {
    ...value,
    sourceName: value.sourceName ?? sourceName,
    ...(value.relatedInformation === undefined
      ? {}
      : {
          relatedInformation: value.relatedInformation.map((related) => ({
            ...related,
            sourceName: related.sourceName ?? sourceName,
          })),
        }),
  };
}

function hasErrors(values: readonly Diagnostic[]): boolean {
  return values.some((value) => value.category === "error");
}

function describeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function normalizeLoadResult(value: unknown): FileModuleLoadResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return { ok: false, message: "The File Module loader returned an invalid result." };
  }
  if (value.ok === false) {
    const message: unknown = Reflect.get(value, "message");
    return typeof message === "string"
      ? { ok: false, message }
      : { ok: false, message: "The File Module loader returned an invalid error result." };
  }
  const source = (value as { readonly source?: unknown }).source;
  if (
    value.ok !== true
    || typeof source !== "object"
    || source === null
    || typeof (source as { readonly name?: unknown }).name !== "string"
    || typeof (source as { readonly text?: unknown }).text !== "string"
  ) {
    return { ok: false, message: "The File Module loader returned an invalid source unit." };
  }
  return {
    ok: true,
    source: {
      name: (source as { readonly name: string }).name,
      text: (source as { readonly text: string }).text,
    },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
