import { describe, expect, it } from "vitest";
import { buildRows, feedColumns, resolveExpression } from "../src/cj/transform";
import { baseOptions, product } from "./fixtures";

describe("buildRows", () => {
  it("maps a simple single-variant product to a CJ row", () => {
    const { rows, rowsWritten, rowsRejected } = buildRows([product()], baseOptions);
    expect(rowsRejected).toBe(0);
    expect(rowsWritten).toBe(1);

    const row = rows[0];
    expect(row.id).toBe("RCK-PLSH-12");
    expect(row.title).toBe("Rocky Plush");
    expect(row.description).toBe("A soft Rocky. • 12 inches");
    expect(row.link).toContain("utm_source=cj");
    expect(row.image_link).toBe("https://cdn.example.com/rocky.jpg");
    expect(row.availability).toBe("in stock");
    expect(row.price).toBe("24.99 USD");
    expect(row.sale_price).toBe("");
    expect(row.brand).toBe("Toynk");
    expect(row.gtin).toBe("012345678905");
    expect(row.mpn).toBe("RCK-PLSH-12");
    expect(row.identifier_exists).toBe("yes");
    expect(row.condition).toBe("new");
    // Single-variant products must not claim a variant group.
    expect(row.item_group_id).toBe("");
    expect(row["shipping(country:service:price)"]).toBe("US::0.00 USD");
  });

  it("swaps Shopify's price semantics for CJ's", () => {
    const [row] = buildRows(
      [product({ variants: [{ ...product().variants[0], price: "19.99", compareAtPrice: "29.99" }] })],
      baseOptions,
    ).rows;
    expect(row.price).toBe("29.99 USD");
    expect(row.sale_price).toBe("19.99 USD");
  });

  it("ignores a compare-at price that is not actually higher", () => {
    const [row] = buildRows(
      [product({ variants: [{ ...product().variants[0], price: "24.99", compareAtPrice: "24.99" }] })],
      baseOptions,
    ).rows;
    expect(row.price).toBe("24.99 USD");
    expect(row.sale_price).toBe("");
  });

  it("names the variant in the title and sets item_group_id for multi-variant products", () => {
    const base = product().variants[0];
    const { rows } = buildRows(
      [
        product({
          variants: [
            { ...base, id: "gid://shopify/ProductVariant/1", sku: "A", title: "Red / S",
              selectedOptions: [{ name: "Color", value: "Red" }, { name: "Size", value: "S" }] },
            { ...base, id: "gid://shopify/ProductVariant/2", sku: "B", title: "Blue / M",
              selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Size", value: "M" }] },
          ],
        }),
      ],
      baseOptions,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("Rocky Plush - Red / S");
    expect(rows[0].color).toBe("Red");
    expect(rows[0].size).toBe("S");
    expect(rows[0].item_group_id).toBe("111");
    expect(rows[1].item_group_id).toBe("111");
    expect(rows[0].link).toContain("variant=1");
  });

  it("treats oversellable zero-stock variants as in stock", () => {
    const [row] = buildRows(
      [product({ variants: [{ ...product().variants[0], availableForSale: false, inventoryPolicy: "CONTINUE" }] })],
      baseOptions,
    ).rows;
    expect(row.availability).toBe("in stock");
  });

  it("marks genuinely unavailable variants out of stock", () => {
    const [row] = buildRows(
      [product({ variants: [{ ...product().variants[0], availableForSale: false, inventoryPolicy: "DENY" }] })],
      baseOptions,
    ).rows;
    expect(row.availability).toBe("out of stock");
  });

  it("rejects a product with no online store URL", () => {
    const result = buildRows([product({ onlineStoreUrl: null })], baseOptions);
    expect(result.rowsWritten).toBe(0);
    expect(result.rowsRejected).toBe(1);
    expect(result.issues[0].field).toBe("link");
  });

  it("rejects an empty description rather than shipping a row CJ will drop", () => {
    const result = buildRows([product({ descriptionHtml: "   <p></p> " })], baseOptions);
    expect(result.rowsWritten).toBe(0);
    expect(result.issues[0].field).toBe("description");
  });

  it("rejects duplicate SKUs, because CJ drops every row sharing an id", () => {
    const base = product().variants[0];
    const result = buildRows(
      [product({ variants: [base, { ...base, id: "gid://shopify/ProductVariant/1000" }] })],
      baseOptions,
    );
    expect(result.rowsWritten).toBe(1);
    expect(result.rowsRejected).toBe(1);
    expect(result.issues.some((i) => i.message.includes("Duplicate"))).toBe(true);
  });

  it("strips characters CJ does not allow in id and falls back when there is no SKU", () => {
    const result = buildRows(
      [product({ variants: [{ ...product().variants[0], sku: "SKU WITH SPACE&AMP" }] })],
      baseOptions,
    );
    expect(result.rows[0].id).toBe("SKU-WITH-SPACE-AMP");

    const noSku = buildRows(
      [product({ variants: [{ ...product().variants[0], sku: null }] })],
      baseOptions,
    );
    expect(noSku.rows[0].id).toBe("rocky-plush-999");
    expect(noSku.rows[0].mpn).toBe("");
    expect(noSku.rows[0].identifier_exists).toBe("yes"); // brand + gtin still present
  });

  it("sets identifier_exists=no when neither GTIN nor MPN is usable", () => {
    const result = buildRows(
      [product({ variants: [{ ...product().variants[0], sku: null, barcode: "not-a-gtin" }] })],
      baseOptions,
    );
    expect(result.rows[0].gtin).toBe("");
    expect(result.rows[0].identifier_exists).toBe("no");
    expect(result.issues.some((i) => i.field === "gtin" && i.level === "warn")).toBe(true);
  });

  it("drops an invalid-length barcode instead of sending it", () => {
    const result = buildRows(
      [product({ variants: [{ ...product().variants[0], barcode: "12345" }] })],
      baseOptions,
    );
    expect(result.rows[0].gtin).toBe("");
  });

  it("honours tag, vendor, price and stock filters", () => {
    const opts = { ...baseOptions, excludeTags: ["scifi"] };
    expect(buildRows([product()], opts).rowsWritten).toBe(0);

    expect(buildRows([product()], { ...baseOptions, includeTags: ["clearance"] }).rowsWritten).toBe(0);
    expect(buildRows([product()], { ...baseOptions, excludeVendors: ["toynk"] }).rowsWritten).toBe(0);
    expect(buildRows([product()], { ...baseOptions, minPrice: 50 }).rowsWritten).toBe(0);

    const oos = product({ variants: [{ ...product().variants[0], availableForSale: false }] });
    expect(buildRows([oos], { ...baseOptions, includeOutOfStock: false }).rowsWritten).toBe(0);
  });

  it("skips gift cards", () => {
    expect(buildRows([product({ isGiftCard: true })], baseOptions).rowsWritten).toBe(0);
  });

  it("applies overrides and custom labels", () => {
    const opts = {
      ...baseOptions,
      metafieldNamespace: "cj",
      mappingOverrides: { google_product_category: "METAFIELD:gpc", gender: "LITERAL:unisex" },
      customLabels: { custom_label_0: "HAS_TAG:scifi", custom_label_1: "FIELD:productType" },
    };
    const p = product({ metafields: { gpc: "1253" } });
    const { rows, columns } = buildRows([p], opts);
    expect(rows[0].google_product_category).toBe("1253");
    expect(rows[0].gender).toBe("unisex");
    expect(rows[0].custom_label_0).toBe("yes");
    expect(rows[0].custom_label_1).toBe("Plush");
    expect(columns).toContain("custom_label_0");
    expect(columns).not.toContain("custom_label_2");
  });

  it("reads google_product_category from a metafield with no override configured", () => {
    const { rows } = buildRows(
      [product({ metafields: { google_product_category: "Toys & Games > Toys" } })],
      baseOptions,
    );
    expect(rows[0].google_product_category).toBe("Toys & Games > Toys");
  });

  it("stops at maxRows", () => {
    const base = product().variants[0];
    const many = product({
      variants: Array.from({ length: 5 }, (_, i) => ({
        ...base, id: `gid://shopify/ProductVariant/${i}`, sku: `SKU-${i}`,
      })),
    });
    expect(buildRows([many], { ...baseOptions, maxRows: 3 }).rowsWritten).toBe(3);
  });

  it("emits the tax column only when a rate is configured", () => {
    expect(feedColumns(baseOptions).some((c) => c.startsWith("tax("))).toBe(false);
    expect(feedColumns({ ...baseOptions, taxRate: "8.75" }).some((c) => c.startsWith("tax("))).toBe(true);
  });
});

describe("resolveExpression", () => {
  const p = product({ tags: ["season-holiday", "clearance"], metafields: { gpc: "1253" } });
  const v = p.variants[0];

  it("handles each expression kind", () => {
    expect(resolveExpression("LITERAL:hello", p, v)).toBe("hello");
    expect(resolveExpression("METAFIELD:gpc", p, v)).toBe("1253");
    expect(resolveExpression("METAFIELD:missing", p, v)).toBe("");
    expect(resolveExpression("TAG_PREFIX:season-", p, v)).toBe("holiday");
    expect(resolveExpression("HAS_TAG:clearance", p, v)).toBe("yes");
    expect(resolveExpression("HAS_TAG:nope", p, v)).toBe("");
    expect(resolveExpression("FIELD:vendor", p, v)).toBe("Toynk");
    expect(resolveExpression("FIELD:sku", p, v)).toBe("RCK-PLSH-12");
    expect(resolveExpression("FIELD:unknown", p, v)).toBe("");
    expect(resolveExpression("just a string", p, v)).toBe("just a string");
  });
});

describe("issue counting beyond the sample cap", () => {
  // Every product here triggers exactly one warning (no google_product_category),
  // so the totals are known and can be checked against the capped sample.
  function manyWarningProducts(n: number) {
    const base = product();
    return Array.from({ length: n }, (_, i) => ({
      ...base,
      id: `gid://shopify/Product/${i}`,
      handle: `p-${i}`,
      variants: [{ ...base.variants[0], id: `gid://shopify/ProductVariant/${i}`, sku: `SKU-${i}` }],
    }));
  }

  it("counts every warned row, not just the ones in the sample", () => {
    const result = buildRows(manyWarningProducts(600), baseOptions);

    expect(result.rowsWritten).toBe(600);
    // The bug this pins: rowsWarned used to stop at the sample limit.
    expect(result.rowsWarned).toBe(600);
    expect(result.issues.length).toBe(500);
    expect(result.issuesTruncated).toBe(true);
    expect(result.issueCountsByField.google_product_category).toBe(600);
  });

  it("does not flag truncation when everything fits", () => {
    const result = buildRows(manyWarningProducts(3), baseOptions);
    expect(result.issuesTruncated).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(result.rowsWarned).toBe(3);
    expect(result.issueCountsByField.google_product_category).toBe(3);
  });

  it("counts a row with several warnings once", () => {
    const base = product();
    const result = buildRows(
      [{ ...base, images: [], variants: [{ ...base.variants[0], barcode: "nope" }] }],
      baseOptions,
    );
    expect(result.rowsWarned).toBe(1);
    // …but each distinct problem is still counted in its own field.
    expect(result.issueCountsByField.image_link).toBe(1);
    expect(result.issueCountsByField.gtin).toBe(1);
    expect(result.issueCountsByField.google_product_category).toBe(1);
  });

  it("maps google_product_category from Shopify's taxonomy when told to", () => {
    const result = buildRows([product()], {
      ...baseOptions,
      mappingOverrides: { google_product_category: "FIELD:category" },
    });
    expect(result.rows[0].google_product_category).toBe("Toys & Games > Toys > Stuffed Animals");
    // The warning is gone, because the field is populated.
    expect(result.issueCountsByField.google_product_category).toBeUndefined();
  });
});

describe("filter reporting", () => {
  // A mis-set excludeTags once removed 415 sellable products with nothing in
  // the output to say why. Every exclusion is now a counted, named reason.
  it("counts skipped products by reason", () => {
    const products = [
      product({ id: "gid://shopify/Product/1", handle: "a", tags: ["clearance"] }),
      product({ id: "gid://shopify/Product/2", handle: "b", tags: ["clearance"] }),
      product({ id: "gid://shopify/Product/3", handle: "c", vendor: "Other" }),
      product({ id: "gid://shopify/Product/4", handle: "d", isGiftCard: true }),
      product({ id: "gid://shopify/Product/5", handle: "e" }),
    ].map((p, i) => ({ ...p, variants: [{ ...p.variants[0], sku: `SKU-${i}` }] }));

    const result = buildRows(products, {
      ...baseOptions,
      excludeTags: ["clearance"],
      excludeVendors: ["Other"],
    });

    expect(result.productsSkipped).toEqual({
      "excluded tag": 2,
      "excluded vendor": 1,
      "gift card": 1,
    });
    expect(result.rowsWritten).toBe(1);
  });

  it("reports nothing skipped when no filter matches", () => {
    expect(buildRows([product()], baseOptions).productsSkipped).toEqual({});
  });

  it("counts a product held back for missing a required tag", () => {
    const result = buildRows([product()], { ...baseOptions, includeTags: ["featured"] });
    expect(result.productsSkipped).toEqual({ "missing required tag": 1 });
  });
});
