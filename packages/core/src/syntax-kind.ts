export const enum SyntaxKind {
  EndOfFileToken,
  UnknownToken,

  IdentifierToken,
  NumberLiteralToken,
  StringLiteralToken,

  IfKeyword,
  ElseKeyword,
  LetKeyword,
  FnKeyword,
  MatchKeyword,
  NilKeyword,
  TrueKeyword,
  FalseKeyword,
  NotKeyword,
  AndKeyword,
  OrKeyword,

  OpenParenToken,
  CloseParenToken,
  OpenBracketToken,
  CloseBracketToken,
  OpenBraceToken,
  CloseBraceToken,
  CommaToken,
  SemicolonToken,
  ColonToken,
  DotToken,
  ArrowToken,
  EqualsToken,
  EqualsEqualsToken,
  BangEqualsToken,
  AmpersandAmpersandToken,
  BarBarToken,
  LessThanToken,
  LessThanEqualsToken,
  GreaterThanToken,
  GreaterThanEqualsToken,
  PlusToken,
  MinusToken,
  AsteriskToken,
  SlashToken,
  PercentToken,
}

const keywordKinds = new Map<string, SyntaxKind>([
  ["if", SyntaxKind.IfKeyword],
  ["else", SyntaxKind.ElseKeyword],
  ["let", SyntaxKind.LetKeyword],
  ["fn", SyntaxKind.FnKeyword],
  ["match", SyntaxKind.MatchKeyword],
  ["nil", SyntaxKind.NilKeyword],
  ["true", SyntaxKind.TrueKeyword],
  ["false", SyntaxKind.FalseKeyword],
  ["not", SyntaxKind.NotKeyword],
  ["and", SyntaxKind.AndKeyword],
  ["or", SyntaxKind.OrKeyword],
]);

export function keywordKind(text: string): SyntaxKind | undefined {
  return keywordKinds.get(text);
}
