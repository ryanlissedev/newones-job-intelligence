/** Parser version for saved searches and golden fixtures (AE1). */
export const BOOLEAN_PARSER_VERSION = 1 as const;

export type BooleanParserVersion = typeof BOOLEAN_PARSER_VERSION;

export interface BooleanTerm {
  kind: "term";
  value: string;
}

export interface BooleanPhrase {
  kind: "phrase";
  value: string;
}

export interface BooleanNot {
  kind: "not";
  operand: BooleanNode;
}

export interface BooleanAnd {
  kind: "and";
  operands: BooleanNode[];
}

export interface BooleanOr {
  kind: "or";
  operands: BooleanNode[];
}

export type BooleanNode =
  | BooleanTerm
  | BooleanPhrase
  | BooleanNot
  | BooleanAnd
  | BooleanOr;

export interface BooleanParseError {
  code: "syntax_error";
  message: string;
  offset: number;
}

export type BooleanParseResult =
  | { ok: true; ast: BooleanNode; version: BooleanParserVersion }
  | { ok: false; error: BooleanParseError };
