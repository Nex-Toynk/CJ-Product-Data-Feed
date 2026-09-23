import { describe, expect, it } from "vitest";
import { toDelimited, toXml } from "../src/cj/serialize";
import { htmlToText, money, normalizeGtin, truncate } from "../src/cj/text";

describe("toDelimited", () => {
  const columns = ["id", "title", "shipping(country:service:price)"];

  it("writes a header and quotes only what needs quoting", () => {
    const out = toDelimited(columns, [{ id: "A1", title: "Plain", "shipping(country:service:price)": "US::0.00 USD" }], ",");
    expect(out).toBe('id,title,shipping(country:service:price)\nA1,Plain,US::0.00 USD\n');
  });

  it("quotes and escapes values containing the delimiter or quotes", () => {
    const out = toDelimited(["id", "title"], [{ id: "A1", title: 'Red, 12" tall' }], ",");
    expect(out.split("\n")[1]).toBe('A1,"Red, 12"" tall"');
  });

  it("strips delimiters instead of quoting when the feed is registered unquoted", () => {
    const out = toDelimited(["id", "title"], [{ id: "A1", title: "Red, big" }], ",", false);
    expect(out.split("\n")[1]).toBe("A1,Red big");
  });

  it("fills missing columns with empty strings so rows stay aligned", () => {
    const out = toDelimited(["id", "title", "gtin"], [{ id: "A1" }], ",");
    expect(out.split("\n")[1]).toBe("A1,,");
  });

  it("supports tab and pipe delimiters", () => {
    expect(toDelimited(["id"], [{ id: "A1" }], "\t")).toContain("id\nA1");
    expect(toDelimited(["id", "t"], [{ id: "A1", t: "x|y" }], "|").split("\n")[1]).toBe('A1,"x|y"'.replace(",", "|"));
  });
});

describe("toXml", () => {
  it("emits g:-namespaced items and nests compound fields", () => {
    const xml = toXml(
      ["id", "title", "shipping(country:service:price)"],
      [{ id: "A1", title: "Rocky & Co", "shipping(country:service:price)": "US::0.00 USD" }],
      { title: "feed", link: "https://example.com", description: "d" },
    );
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml).toContain("<g:id>A1</g:id>");
    expect(xml).toContain("<g:title>Rocky &amp; Co</g:title>");
    expect(xml).toContain("<g:shipping>");
    expect(xml).toContain("<g:country>US</g:country>");
    expect(xml).toContain("<g:price>0.00 USD</g:price>");
    // The empty `service` sub-attribute must not produce an empty element.
    expect(xml).not.toContain("<g:service></g:service>");
  });

  it("omits empty fields entirely", () => {
    const xml = toXml(["id", "gtin"], [{ id: "A1", gtin: "" }], { title: "f", link: "l", description: "d" });
    expect(xml).not.toContain("g:gtin");
  });
});

describe("text helpers", () => {
  it("flattens HTML to single-line text", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One Two");
    expect(htmlToText("<ul><li>A</li><li>B</li></ul>")).toBe("• A • B");
    expect(htmlToText("Line<br>Break")).toBe("Line Break");
    expect(htmlToText("<script>evil()</script>Safe")).toBe("Safe");
    expect(htmlToText("Tom &amp; Jerry&nbsp;&#8212; friends")).toBe("Tom & Jerry — friends");
    expect(htmlToText("has\nnewline\tand tab")).toBe("has newline and tab");
    expect(htmlToText(null)).toBe("");
  });

  it("truncates on a word boundary when it can", () => {
    expect(truncate("hello world", 20)).toBe("hello world");
    expect(truncate("hello beautiful world", 15)).toBe("hello beautiful");
    expect(truncate("supercalifragilistic", 5)).toBe("super");
  });

  it("normalises prices to two decimals with no thousands separator", () => {
    expect(money("24.9")).toBe("24.90");
    expect(money("1,500.00")).toBe("1500.00");
    expect(money(0)).toBe("0.00");
    expect(money("abc")).toBeNull();
    expect(money(null)).toBeNull();
    expect(money("-5")).toBeNull();
  });

  it("accepts only valid GTIN lengths", () => {
    expect(normalizeGtin("012345678905")).toBe("012345678905");
    expect(normalizeGtin("0-123-45678-905")).toBe("012345678905");
    expect(normalizeGtin("123456789")).toBeNull();
    expect(normalizeGtin("")).toBeNull();
  });
});
