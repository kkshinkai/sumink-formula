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
  readonly expressions: readonly Expression[];
}

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

export type ObjectKey =
  | { readonly kind: "StaticObjectKey"; readonly value: string; readonly range: TextRange }
  | { readonly kind: "ComputedObjectKey"; readonly expression: Expression; readonly range: TextRange };

export interface ObjectMember extends AstNodeBase {
  readonly kind: "ObjectMember";
  readonly key: ObjectKey;
  readonly value: Expression;
}

export interface ObjectExpression extends AstNodeBase {
  readonly kind: "ObjectExpression";
  readonly members: readonly ObjectMember[];
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
  readonly expressions: readonly Expression[];
}

export interface ConditionalBranch {
  readonly condition: Expression;
  readonly result: Expression;
  readonly range: TextRange;
}

export interface IfExpression extends AstNodeBase {
  readonly kind: "IfExpression";
  readonly branches: readonly ConditionalBranch[];
  readonly elseBranch: Expression;
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
}

export interface ComputedSelectorExpression extends AstNodeBase {
  readonly kind: "ComputedSelectorExpression";
  readonly receiver: Expression;
  readonly selector: Expression;
}

export interface LetBinding extends AstNodeBase {
  readonly kind: "LetBinding";
  readonly pattern: Pattern;
  readonly value: Expression;
}

export interface LetExpression extends AstNodeBase {
  readonly kind: "LetExpression";
  readonly bindings: readonly LetBinding[];
  readonly body: Expression;
}

export interface MatchTestExpression extends AstNodeBase {
  readonly kind: "MatchTestExpression";
  readonly subject: Expression;
  readonly pattern: Pattern;
}

export interface MatchCase extends AstNodeBase {
  readonly kind: "MatchCase";
  readonly pattern: Pattern;
  readonly result: Expression;
}

export interface MatchSelectionExpression extends AstNodeBase {
  readonly kind: "MatchSelectionExpression";
  readonly subject: Expression;
  readonly cases: readonly MatchCase[];
  readonly elseBranch?: Expression;
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
  | ObjectExpression
  | CallExpression
  | GroupedExpression
  | ClosureExpression
  | BlockExpression
  | IfExpression
  | PrefixOperatorExpression
  | InfixOperatorExpression
  | FieldSelectorExpression
  | ComputedSelectorExpression
  | LetExpression
  | MatchTestExpression
  | MatchSelectionExpression;
