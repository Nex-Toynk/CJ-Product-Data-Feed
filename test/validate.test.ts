import { describe, expect, it } from "vitest";
import { validateRows, summarize } from "../src/cj/validate";
import { buildRows, feedColumns } from "../src/cj/transform";
import { baseOptions, product } from "./fixtures";

describe("validateRows", () => {
  it("passes a feed built by the mapper", () => {
    const { columns, rows } = buildRows([product()], baseOptions);
    const issues = validateRows(columns, rows);
    expect(issues.filter((i) => i.level === "reject")).toEqual([]);
  });

  it("flags a header missing a required CJ column", () => {
    const issues = validateRows(["id", "title"], []);
    const fields = issues.map((i) => i.field);
    expect(fields).toContain("description");
    expect(fields).toContain("link");
    expect(fields).toContain("availability");
    expect(fields).toContain("price");
    expect(fields).toContain("condition");
    expect(fields).toContain("shipping");
  });

  it("rejects bad enums, URLs and prices", () => {
    const columns = feedColumns(baseOptions);
    const [good] = buildRows([product()], baseOptions).rows;

    const bad = { ...good, availability: "maybe", link: "example.com/x", price: "24.9", condition: "mint" };
    const issues = validateRows(columns, [bad]);
    const rejected = issues.filter((i) => i.level === "reject").map((i) => i.field);

    expect(rejected).toContain("availability");
    expect(rejected).toContain("link");
    expect(rejected).toContain("price");
    expect(rejected).toContain("condition");
  });

  it("warns rather than rejects on over-length values", () => {
    const columns = feedColumns(baseOptions);
    const [good] = buildRows([product()], baseOptions).rows;
    const issues = validateRows(columns, [{ ...good, title: "x".repeat(200) }]);
    const title = issues.find((i) => i.field === "title");
    expect(title?.level).toBe("warn");
  });

  it("catches duplicate ids that slipped past the mapper", () => {
    const columns = feedColumns(baseOptions);
    const [good] = buildRows([product()], baseOptions).rows;
    const issues = validateRows(columns, [good, good]);
    expect(issues.some((i) => i.field === "id" && i.level === "reject")).toBe(true);
  });

  it("summarises by severity and field", () => {
    const s = summarize([
      { id: "a", field: "gtin", level: "warn", stage: "build", message: "" },
      { id: "b", field: "gtin", level: "warn", stage: "build", message: "" },
      { id: "c", field: "link", level: "reject", stage: "build", message: "" },
    ]);
    expect(s.rejectCount).toBe(1);
    expect(s.warnCount).toBe(2);
    expect(s.topFields[0]).toEqual(["gtin", 2]);
  });
});

describe("image_link is a warning, not a dropped row", () => {
  it("does not reject a row that has no image", () => {
    // CJ's field detail: a product with no valid image link is "accepted
    // without this value". Treating it as required produced phantom rejects.
    const columns = feedColumns(baseOptions);
    const [good] = buildRows([product()], baseOptions).rows;
    const issues = validateRows(columns, [{ ...good, image_link: "" }]);
    expect(issues.filter((i) => i.field === "image_link" && i.level === "reject")).toEqual([]);
  });

  it("still warns once, from the mapper, when a product has no image", () => {
    const result = buildRows([product({ images: [] })], baseOptions);
    expect(result.rowsWritten).toBe(1);
    expect(result.issueCountsByField.image_link).toBe(1);

    // And the validator must not double-count the same absence.
    const all = [...result.issues, ...validateRows(result.columns, result.rows)];
    expect(all.filter((i) => i.field === "image_link")).toHaveLength(1);
  });
});

describe("issue stages", () => {
  it("tags mapper issues as build and validator issues as validate", () => {
    const result = buildRows([product({ onlineStoreUrl: null })], baseOptions);
    expect(result.issues[0].stage).toBe("build");

    const columns = feedColumns(baseOptions);
    const [good] = buildRows([product()], baseOptions).rows;
    const issues = validateRows(columns, [{ ...good, availability: "maybe" }]);
    expect(issues.every((i) => i.stage === "validate")).toBe(true);
  });

  it("reports a duplicate id alongside the product that already claimed it", () => {
    const base = product().variants[0];
    const result = buildRows(
      [product({ variants: [base, { ...base, id: "gid://shopify/ProductVariant/1000" }] })],
      baseOptions,
    );
    const dupe = result.issues.find((i) => i.field === "id")!;
    expect(dupe.message).toContain("rocky-plush");
    expect(dupe.stage).toBe("build");
  });
});
