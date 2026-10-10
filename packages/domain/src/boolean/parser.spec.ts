import { describe, expect, it } from "bun:test";

import { BOOLEAN_PARSER_VERSION, parseBooleanQuery } from "./index";
import type { BooleanNode } from "./index";

const expectOk = (input: string): BooleanNode => {
  const result = parseBooleanQuery(input);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  expect(result.version).toBe(BOOLEAN_PARSER_VERSION);
  return result.ast;
};

const expectError = (input: string, messageIncludes: string): void => {
  const result = parseBooleanQuery(input);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected parse error");
  }

  expect(result.error.code).toBe("syntax_error");
  expect(result.error.message).toContain(messageIncludes);
};

describe("parseBooleanQuery", () => {
  it("covers AE1 with OR, phrase, and NOT precedence", () => {
    const ast = expectOk('(Azure OR "platform engineer") NOT intern');

    expect(ast).toEqual({
      kind: "and",
      operands: [
        {
          kind: "or",
          operands: [
            { kind: "term", value: "Azure" },
            { kind: "phrase", value: "platform engineer" },
          ],
        },
        {
          kind: "not",
          operand: { kind: "term", value: "intern" },
        },
      ],
    });

    const second = parseBooleanQuery(
      '(Azure OR "platform engineer") NOT intern'
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.ast).toEqual(ast);
    }
  });

  it("parses explicit AND and OR with left-associative grouping", () => {
    expect(expectOk("foo AND bar OR baz")).toEqual({
      kind: "or",
      operands: [
        {
          kind: "and",
          operands: [
            { kind: "term", value: "foo" },
            { kind: "term", value: "bar" },
          ],
        },
        { kind: "term", value: "baz" },
      ],
    });
  });

  it("parses nested NOT", () => {
    expect(expectOk("NOT NOT intern")).toEqual({
      kind: "not",
      operand: {
        kind: "not",
        operand: { kind: "term", value: "intern" },
      },
    });
  });

  it("rejects unclosed parenthesis", () => {
    expectError("(Azure OR intern", "Unclosed parenthesis");
  });

  it("rejects empty AND", () => {
    expectError("Azure AND", "Unexpected end of query");
    expectError("AND Azure", "Missing operand before AND");
  });

  it("rejects empty query", () => {
    expectError("   ", "Query must not be empty");
  });

  it("rejects unexpected closing parenthesis", () => {
    expectError("Azure)", 'Unexpected token ")"');
  });

  it("parses phrase escapes", () => {
    expect(expectOk(String.raw`"platform \"engineer\""`)).toEqual({
      kind: "phrase",
      value: 'platform "engineer"',
    });
  });

  it("accepts case-insensitive AND/OR/NOT (CTP-508)", () => {
    expect(expectOk("azure and data or cloud")).toEqual(
      expectOk("azure AND data OR cloud")
    );
    expect(expectOk("not intern")).toEqual(expectOk("NOT intern"));
  });
});
