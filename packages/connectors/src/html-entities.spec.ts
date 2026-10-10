import { describe, expect, it } from "bun:test";

import { decodeHtmlEntities } from "./html-entities";

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
    expect(decodeHtmlEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes valid decimal and hex numeric entities", () => {
    expect(decodeHtmlEntities("&#8364;")).toBe("€");
    expect(decodeHtmlEntities("&#x20AC;")).toBe("€");
    expect(decodeHtmlEntities("&#039;")).toBe("'");
  });

  it("leaves an out-of-range decimal numeric entity untouched instead of throwing (RJC-374)", () => {
    expect(() => decodeHtmlEntities("&#1114112;")).not.toThrow();
    expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;");
  });

  it("leaves an out-of-range hex numeric entity untouched instead of throwing", () => {
    expect(() => decodeHtmlEntities("&#x110000;")).not.toThrow();
    expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
  });

  it("leaves a lone-surrogate numeric entity untouched instead of throwing", () => {
    expect(() => decodeHtmlEntities("&#xD800;")).not.toThrow();
    expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;");
    // 0xD800 in decimal form
    expect(decodeHtmlEntities("&#55296;")).toBe("&#55296;");
    expect(decodeHtmlEntities("&#xDFFF;")).toBe("&#xDFFF;");
  });

  it("leaves an unrecognised named entity untouched", () => {
    expect(decodeHtmlEntities("&notreal;")).toBe("&notreal;");
  });

  it("mixes valid and invalid entities in one string, resolving only the valid ones", () => {
    expect(decodeHtmlEntities("&amp; &#1114112; &#8364;")).toBe(
      "& &#1114112; €"
    );
  });
});
