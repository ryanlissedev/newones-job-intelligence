import { BOOLEAN_PARSER_VERSION } from "./ast";
import type {
  BooleanAnd,
  BooleanNode,
  BooleanNot,
  BooleanOr,
  BooleanParseResult,
  BooleanPhrase,
  BooleanTerm,
} from "./ast";

const KEYWORD_OR = "OR";
const KEYWORD_AND = "AND";
const KEYWORD_NOT = "NOT";

type TokenKind =
  | "term"
  | "phrase"
  | "lparen"
  | "rparen"
  | "or"
  | "and"
  | "not"
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
}

interface TokenizeError {
  message: string;
  offset: number;
}

interface TokenReadResult {
  token: Token;
  nextIndex: number;
}

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r";

const isTermChar = (char: string): boolean =>
  !isWhitespace(char) && char !== "(" && char !== ")" && char !== '"';

const keywordAt = (input: string, index: number, keyword: string): boolean => {
  const slice = input.slice(index, index + keyword.length);
  if (slice.toUpperCase() !== keyword) {
    return false;
  }

  const after = input[index + keyword.length];
  if (after !== undefined && isTermChar(after)) {
    return false;
  }

  return true;
};

const readPhrase = (
  input: string,
  start: number
): TokenReadResult | { error: TokenizeError } => {
  let index = start + 1;
  let value = "";

  while (index < input.length) {
    const current = input[index];
    if (current === undefined) {
      return { error: { message: "Unclosed phrase", offset: start } };
    }

    if (current === '"') {
      return {
        nextIndex: index + 1,
        token: { kind: "phrase", offset: start, value },
      };
    }

    if (current === "\\" && index + 1 < input.length) {
      index += 1;
      const escaped = input[index];
      if (escaped !== undefined) {
        value += escaped;
      }
      index += 1;
      continue;
    }

    value += current;
    index += 1;
  }

  return { error: { message: "Unclosed phrase", offset: start } };
};

const readTerm = (input: string, start: number) => {
  let index = start;
  let value = "";

  while (index < input.length) {
    const current = input[index];
    if (current === undefined || !isTermChar(current)) {
      break;
    }

    value += current;
    index += 1;
  }

  return {
    nextIndex: index,
    token: { kind: "term" as const, offset: start, value },
  } satisfies TokenReadResult;
};

const readKeywordToken = (
  _input: string,
  index: number,
  keyword: string,
  kind: "or" | "and" | "not"
): Token => ({
  kind,
  offset: index,
  value: keyword,
});

const tokenize = (input: string): Token[] | { error: TokenizeError } => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === undefined) {
      break;
    }

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ kind: "lparen", offset: index, value: "(" });
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ kind: "rparen", offset: index, value: ")" });
      index += 1;
      continue;
    }

    if (char === '"') {
      const phrase = readPhrase(input, index);
      if ("error" in phrase) {
        return { error: phrase.error };
      }

      tokens.push(phrase.token);
      index = phrase.nextIndex;
      continue;
    }

    if (keywordAt(input, index, KEYWORD_OR)) {
      tokens.push(readKeywordToken(input, index, KEYWORD_OR, "or"));
      index += KEYWORD_OR.length;
      continue;
    }

    if (keywordAt(input, index, KEYWORD_AND)) {
      tokens.push(readKeywordToken(input, index, KEYWORD_AND, "and"));
      index += KEYWORD_AND.length;
      continue;
    }

    if (keywordAt(input, index, KEYWORD_NOT)) {
      tokens.push(readKeywordToken(input, index, KEYWORD_NOT, "not"));
      index += KEYWORD_NOT.length;
      continue;
    }

    if (!isTermChar(char)) {
      return {
        error: { message: `Unexpected character "${char}"`, offset: index },
      };
    }

    const term = readTerm(input, index);
    tokens.push(term.token);
    index = term.nextIndex;
  }

  tokens.push({ kind: "eof", offset: input.length, value: "" });
  return tokens;
};

const collapseOperands = (
  kind: "and" | "or",
  operands: BooleanNode[]
): BooleanNode => {
  const single = operands.at(0);
  if (operands.length === 1 && single !== undefined) {
    return single;
  }

  if (kind === "and") {
    const node: BooleanAnd = { kind: "and", operands };
    return node;
  }

  const node: BooleanOr = { kind: "or", operands };
  return node;
};

const isImplicitAndStart = (kind: TokenKind): boolean =>
  kind === "term" || kind === "phrase" || kind === "not" || kind === "lparen";

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): BooleanNode | { message: string; offset: number } {
    const query = this.parseOr();
    if ("message" in query) {
      return query;
    }

    if (this.peek().kind !== "eof") {
      const token = this.peek();
      return {
        message: `Unexpected token "${token.value || token.kind}"`,
        offset: token.offset,
      };
    }

    return query;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof", offset: 0, value: "" };
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "eof") {
      this.index += 1;
    }

    return token;
  }

  private parseOr(): BooleanNode | { message: string; offset: number } {
    const first = this.parseAnd();
    if ("message" in first) {
      return first;
    }

    const operands: BooleanNode[] = [first];

    while (this.peek().kind === "or") {
      this.advance();
      const next = this.parseAnd();
      if ("message" in next) {
        return next;
      }

      operands.push(next);
    }

    return collapseOperands("or", operands);
  }

  private parseAnd(): BooleanNode | { message: string; offset: number } {
    const first = this.parseNot();
    if ("message" in first) {
      return first;
    }

    const operands: BooleanNode[] = [first];

    while (true) {
      const token = this.peek();

      if (token.kind === "and") {
        this.advance();
        const next = this.parseNot();
        if ("message" in next) {
          return next;
        }

        operands.push(next);
        continue;
      }

      if (isImplicitAndStart(token.kind)) {
        const next = this.parseNot();
        if ("message" in next) {
          return next;
        }

        operands.push(next);
        continue;
      }

      break;
    }

    return collapseOperands("and", operands);
  }

  private parseNot(): BooleanNode | { message: string; offset: number } {
    if (this.peek().kind === "not") {
      this.advance();
      const operand = this.parseNot();
      if ("message" in operand) {
        return operand;
      }

      const node: BooleanNot = { kind: "not", operand };
      return node;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): BooleanNode | { message: string; offset: number } {
    const token = this.peek();

    if (token.kind === "term") {
      this.advance();
      const node: BooleanTerm = { kind: "term", value: token.value };
      return node;
    }

    if (token.kind === "phrase") {
      this.advance();
      const node: BooleanPhrase = { kind: "phrase", value: token.value };
      return node;
    }

    if (token.kind === "lparen") {
      this.advance();
      const inner = this.parseOr();
      if ("message" in inner) {
        return inner;
      }

      if (this.peek().kind !== "rparen") {
        return { message: "Unclosed parenthesis", offset: token.offset };
      }

      this.advance();
      return inner;
    }

    if (token.kind === "and") {
      return { message: "Missing operand before AND", offset: token.offset };
    }

    if (token.kind === "or") {
      return { message: "Missing operand before OR", offset: token.offset };
    }

    if (token.kind === "rparen") {
      return {
        message: "Unexpected closing parenthesis",
        offset: token.offset,
      };
    }

    if (token.kind === "eof") {
      return { message: "Unexpected end of query", offset: token.offset };
    }

    return {
      message: "Expected term, phrase, or grouped expression",
      offset: token.offset,
    };
  }
}

export const parseBooleanQuery = (input: string): BooleanParseResult => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      error: {
        code: "syntax_error",
        message: "Query must not be empty",
        offset: 0,
      },
      ok: false,
    };
  }

  const tokenized = tokenize(trimmed);
  if ("error" in tokenized) {
    return {
      error: {
        code: "syntax_error",
        message: tokenized.error.message,
        offset: tokenized.error.offset,
      },
      ok: false,
    };
  }

  const parsed = new Parser(tokenized).parse();
  if ("message" in parsed) {
    return {
      error: {
        code: "syntax_error",
        message: parsed.message,
        offset: parsed.offset,
      },
      ok: false,
    };
  }

  return {
    ast: parsed,
    ok: true,
    version: BOOLEAN_PARSER_VERSION,
  };
};
