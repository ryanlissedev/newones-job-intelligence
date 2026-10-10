import { describe, expect, it } from "bun:test";

import {
  buildKnnQueryText,
  emitMatch,
  buildQueryString,
  SEARCH_TITLE_SCOPE_FIELDS,
} from "./emitter";

describe("manticore emitter", () => {
  it("covers AE1 MATCH for phrase + OR + NOT", () => {
    const queryString = buildQueryString({
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

    expect(queryString).toBe(
      '@(titel,beschrijving,opdrachtgever_naam) (Azure | "platform engineer") -intern'
    );
    expect(emitMatch({ kind: "term", value: "Azure" })).toBe("Azure");
  });

  it("escapes special characters in terms", () => {
    expect(emitMatch({ kind: "term", value: "foo/bar" })).toBe('"foo/bar"');
  });

  it("CTP-508: title scope MATCH uses titel+opdrachtgever only", () => {
    const queryString = buildQueryString(
      { kind: "term", value: "Azure" },
      SEARCH_TITLE_SCOPE_FIELDS
    );
    expect(queryString).toBe("@(titel,opdrachtgever_naam) Azure");
  });

  it("CTP-508: default MATCH covers full vacature fields", () => {
    const queryString = buildQueryString({
      kind: "and",
      operands: [
        { kind: "term", value: "Azure" },
        { kind: "term", value: "Kubernetes" },
      ],
    });
    expect(queryString).toBe(
      "@(titel,beschrijving,opdrachtgever_naam) Azure Kubernetes"
    );
  });

  it("builds auto-embedding text from positive terms and phrases only", () => {
    expect(
      buildKnnQueryText({
        kind: "and",
        operands: [
          { kind: "term", value: "Azure" },
          { kind: "phrase", value: "platform engineer" },
          {
            kind: "not",
            operand: {
              kind: "or",
              operands: [
                { kind: "term", value: "intern" },
                { kind: "term", value: "junior" },
              ],
            },
          },
        ],
      })
    ).toBe("Azure platform engineer");
  });

  it("returns null for NOT-only ASTs", () => {
    expect(
      buildKnnQueryText({
        kind: "not",
        operand: { kind: "term", value: "intern" },
      })
    ).toBeNull();
  });
});
