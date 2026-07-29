import type { TextRange } from "./text.js";

declare const nodeIdBrand: unique symbol;
export type NodeId = number & { readonly [nodeIdBrand]: true };

export type LiteralValue = null | boolean | number | string;

interface AstNodeBase {
  readonly id: NodeId;
  readonly range: TextRange;
}

export interface Program extends AstNodeBase {
  readonly kind: "Program";
  readonly items: readonly ProgramItem[];
}

export interface FileModule extends AstNodeBase {
  readonly kind: "FileModule";
  readonly items: readonly ModuleItem[];
}

export interface LetStatement extends AstNodeBase {
  readonly kind: "LetStatement";
  readonly pattern: Pattern;
  readonly value: Expression;
}

export interface FnStatement extends AstNodeBase {
  readonly kind: "FnStatement";
  readonly name: string;
  readonly nameRange: TextRange;
  readonly parameters: readonly Pattern[];
  readonly body: Expression;
}

export interface ExpressionStatement extends AstNodeBase {
  readonly kind: "ExpressionStatement";
  readonly expression: Expression;
}

export type Statement = LetStatement | FnStatement | ExpressionStatement;

export interface ModulePathSegment {
  readonly name: string;
  readonly range: TextRange;
}

export interface ModulePath extends AstNodeBase {
  readonly kind: "ModulePath";
  readonly segments: readonly ModulePathSegment[];
}

export interface NamedImportSelector extends AstNodeBase {
  readonly kind: "NamedImportSelector";
  readonly importedName: string;
  readonly importedNameRange: TextRange;
  readonly localName?: string;
  readonly localNameRange?: TextRange;
  readonly excluded: boolean;
}

export interface WildcardImportSelector extends AstNodeBase {
  readonly kind: "WildcardImportSelector";
}

export type ImportSelector = NamedImportSelector | WildcardImportSelector;

export interface MemberImportClause {
  readonly kind: "MemberImportClause";
  readonly selectors: readonly ImportSelector[];
}

export interface ModuleAliasImportClause {
  readonly kind: "ModuleAliasImportClause";
  readonly localName: string;
  readonly localNameRange: TextRange;
}

export type ImportClause = MemberImportClause | ModuleAliasImportClause;

export interface ImportDeclaration extends AstNodeBase {
  readonly kind: "ImportDeclaration";
  readonly modulePath?: ModulePath;
  readonly source?: string;
  readonly sourceRange?: TextRange;
  readonly clause: ImportClause;
}

export interface ModuleDeclaration extends AstNodeBase {
  readonly kind: "ModuleDeclaration";
  readonly name: string;
  readonly nameRange: TextRange;
  readonly items: readonly ModuleItem[];
}

export type ExportedDeclaration = LetStatement | FnStatement | ModuleDeclaration;

export interface ExportDeclaration extends AstNodeBase {
  readonly kind: "ExportDeclaration";
  readonly declaration?: ExportedDeclaration;
  readonly modulePath?: ModulePath;
  readonly selectors?: readonly ImportSelector[];
}

export type ProgramItem = Statement | ImportDeclaration | ModuleDeclaration;
export type ModuleItem = LetStatement
  | FnStatement
  | ImportDeclaration
  | ExportDeclaration
  | ModuleDeclaration;

export interface ErrorExpression extends AstNodeBase {
  readonly kind: "ErrorExpression";
}

export interface LiteralExpression extends AstNodeBase {
  readonly kind: "LiteralExpression";
  readonly value: LiteralValue;
}

export interface IdentifierExpression extends AstNodeBase {
  readonly kind: "IdentifierExpression";
  readonly name: string;
}

export interface ArrayExpression extends AstNodeBase {
  readonly kind: "ArrayExpression";
  readonly elements: readonly Expression[];
}

export interface DictionaryEntry extends AstNodeBase {
  readonly kind: "DictionaryEntry";
  readonly key: Expression;
  readonly value: Expression;
}

export interface DictionaryExpression extends AstNodeBase {
  readonly kind: "DictionaryExpression";
  readonly entries: readonly DictionaryEntry[];
}

export interface CallExpression extends AstNodeBase {
  readonly kind: "CallExpression";
  readonly callee: Expression;
  readonly arguments: readonly Expression[];
}

export interface GroupedExpression extends AstNodeBase {
  readonly kind: "GroupedExpression";
  readonly expression: Expression;
}

export interface ClosureExpression extends AstNodeBase {
  readonly kind: "ClosureExpression";
  readonly parameters: readonly Pattern[];
  readonly body: Expression;
}

export interface BlockExpression extends AstNodeBase {
  readonly kind: "BlockExpression";
  readonly statements: readonly Statement[];
  readonly result?: Expression;
}

export interface IfExpression extends AstNodeBase {
  readonly kind: "IfExpression";
  readonly condition: Expression;
  readonly consequent: Expression;
  readonly alternative?: Expression;
}

export type PrefixOperator = "-" | "not";
export type InfixOperator = "+" | "-" | "*" | "/" | "%"
  | "<" | "<=" | ">" | ">=" | "==" | "!=" | "and" | "or";

export interface PrefixOperatorExpression extends AstNodeBase {
  readonly kind: "PrefixOperatorExpression";
  readonly operator: PrefixOperator;
  readonly operand: Expression;
}

export interface InfixOperatorExpression extends AstNodeBase {
  readonly kind: "InfixOperatorExpression";
  readonly operator: InfixOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface FieldSelectorExpression extends AstNodeBase {
  readonly kind: "FieldSelectorExpression";
  readonly receiver: Expression;
  readonly field: string;
  readonly fieldRange: TextRange;
}

export interface ComputedSelectorExpression extends AstNodeBase {
  readonly kind: "ComputedSelectorExpression";
  readonly receiver: Expression;
  readonly selector: Expression;
}

export interface MatchTestExpression extends AstNodeBase {
  readonly kind: "MatchTestExpression";
  readonly subject: Expression;
  readonly pattern: Pattern;
}

export interface MatchArm extends AstNodeBase {
  readonly kind: "MatchArm";
  readonly pattern: Pattern;
  readonly result: Expression;
}

export interface MatchSelectionExpression extends AstNodeBase {
  readonly kind: "MatchSelectionExpression";
  readonly subject: Expression;
  readonly arms: readonly MatchArm[];
}

export interface LiteralPattern extends AstNodeBase {
  readonly kind: "LiteralPattern";
  readonly value: LiteralValue;
}

export interface IdentifierPattern extends AstNodeBase {
  readonly kind: "IdentifierPattern";
  readonly name: string;
}

export interface WildcardPattern extends AstNodeBase {
  readonly kind: "WildcardPattern";
}

export interface ErrorPattern extends AstNodeBase {
  readonly kind: "ErrorPattern";
}

export type Pattern = LiteralPattern | IdentifierPattern | WildcardPattern | ErrorPattern;

export type Expression = ErrorExpression
  | LiteralExpression
  | IdentifierExpression
  | ArrayExpression
  | DictionaryExpression
  | CallExpression
  | GroupedExpression
  | ClosureExpression
  | BlockExpression
  | IfExpression
  | PrefixOperatorExpression
  | InfixOperatorExpression
  | FieldSelectorExpression
  | ComputedSelectorExpression
  | MatchTestExpression
  | MatchSelectionExpression;
