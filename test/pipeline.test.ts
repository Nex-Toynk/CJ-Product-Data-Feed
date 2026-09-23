import { describe, expect, it } from "vitest";
import { streamProducts } from "../src/shopify/jsonl";
import { buildRows } from "../src/cj/transform";
import { toDelimited, toXml } from "../src/cj/serialize";
import { validateRows } from "../src/cj/validate";
import { CJ_FIELDS } from "../src/cj/spec";
import { baseOptions } from "./fixtures";

/**
 * End-to-end: a realistic bulk-operation JSONL payload all the way to a file
 * CJ would accept.
 */
const JSONL = [
  {
    __typename: "Product",
    id: "gid://shopify/Product/9001",
    handle: "rocky-plush",
    title: "Project Hail Mary Rocky Plush",
    descriptionHtml: "<p>An <em>Eridian</em> friend.</p><ul><li>12\" tall</li><li>Embroidered</li></ul>",
    vendor: "Toynk",
    productType: "Plush",
    tags: ["scifi", "season-holiday"],
    status: "ACTIVE",
    onlineStoreUrl: "https://toynk.com/products/rocky-plush",
    publishedAt: "2026-02-01T00:00:00Z",
    isGiftCard: false,
    category: { id: "sg-1", fullName: "Toys & Games > Toys > Stuffed Animals" },
    featuredMedia: { preview: { image: { url: "https://cdn.toynk.com/rocky-main.jpg", altText: "Rocky" } } },
  },
  {
    __typename: "MediaImage",
    image: { url: "https://cdn.toynk.com/rocky-side.jpg" },
    __parentId: "gid://shopify/Product/9001",
  },
  {
    __typename: "Metafield",
    namespace: "cj",
    key: "gpc",
    value: "1253",
    __parentId: "gid://shopify/Product/9001",
  },
  {
    __typename: "ProductVariant",
    id: "gid://shopify/ProductVariant/501",
    sku: "PHM-RCK-SM",
    barcode: "0850041234567",
    title: "Small",
    price: "19.99",
    compareAtPrice: "24.99",
    availableForSale: true,
    inventoryQuantity: 42,
    inventoryPolicy: "DENY",
    taxable: true,
    selectedOptions: [{ name: "Size", value: "Small" }],
    inventoryItem: { measurement: { weight: { unit: "POUNDS", value: 0.4 } } },
    __parentId: "gid://shopify/Product/9001",
  },
  {
    __typename: "ProductVariant",
    id: "gid://shopify/ProductVariant/502",
    sku: "PHM-RCK-LG",
    barcode: "0850041234574",
    title: "Large",
    price: "34.99",
    compareAtPrice: null,
    availableForSale: false,
    inventoryQuantity: 0,
    inventoryPolicy: "DENY",
    taxable: true,
    selectedOptions: [{ name: "Size", value: "Large" }],
    inventoryItem: { measurement: { weight: { unit: "POUNDS", value: 0.9 } } },
    __parentId: "gid://shopify/Product/9001",
  },
  {
    // A product that must not reach CJ: no storefront URL.
    __typename: "Product",
    id: "gid://shopify/Product/9002",
    handle: "internal-sample",
    title: "Internal sample",
    descriptionHtml: "<p>Staff only</p>",
    vendor: "Toynk",
    tags: [],
    onlineStoreUrl: null,
  },
  {
    __typename: "ProductVariant",
    id: "gid://shopify/ProductVariant/600",
    sku: "INTERNAL-1",
    price: "0.00",
    availableForSale: true,
    selectedOptions: [],
    __parentId: "gid://shopify/Product/9002",
  },
].map((n) => JSON.stringify(n));

function jsonlStream(lines: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });
}

describe("JSONL to delivered feed", () => {
  it("produces a CJ-acceptable CSV", async () => {
    const products = [];
    for await (const p of streamProducts(jsonlStream(JSONL))) products.push(p);
    expect(products).toHaveLength(2);

    const options = { ...baseOptions, customLabels: { custom_label_0: "TAG_PREFIX:season-" } };
    const built = buildRows(products, options);

    // The unpublished product is dropped, both real variants survive.
    expect(built.rowsWritten).toBe(2);
    expect(built.rowsRejected).toBe(1);

    const issues = validateRows(built.columns, built.rows);
    expect(issues.filter((i) => i.level === "reject")).toEqual([]);

    // Every required CJ column is present in the header.
    const required = CJ_FIELDS.filter((f) => f.requirement === "required").map((f) => f.name);
    for (const name of required) expect(built.columns).toContain(name);
    expect(built.columns.some((c) => c.startsWith("shipping("))).toBe(true);

    const csv = toDelimited(built.columns, built.rows, ",", true);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);

    const header = lines[0].split(",");
    const small = built.rows.find((r) => r.id === "PHM-RCK-SM")!;
    const large = built.rows.find((r) => r.id === "PHM-RCK-LG")!;

    expect(header).toContain("custom_label_0");
    expect(small.custom_label_0).toBe("holiday");
    expect(small.price).toBe("24.99 USD");
    expect(small.sale_price).toBe("19.99 USD");
    expect(small.availability).toBe("in stock");
    expect(small.item_group_id).toBe("9001");
    expect(small.size).toBe("Small");
    expect(small.gtin).toBe("0850041234567");
    expect(small.google_product_category).toBe("1253");
    expect(small.additional_image_link).toBe("https://cdn.toynk.com/rocky-side.jpg");
    expect(small.product_weight).toBe("0.4 lb");
    expect(large.availability).toBe("out of stock");
    expect(large.sale_price).toBe("");

    // The description must survive HTML flattening without breaking the row.
    expect(small.description).toBe('An Eridian friend. • 12" tall • Embroidered');
    expect(csv).toContain('"An Eridian friend. • 12"" tall • Embroidered"');
    // No stray line breaks inside a row.
    expect(csv.split("\n").filter((l) => l.trim()).length).toBe(3);
  });

  it("produces equivalent XML", async () => {
    const products = [];
    for await (const p of streamProducts(jsonlStream(JSONL))) products.push(p);
    const built = buildRows(products, baseOptions);
    const xml = toXml(built.columns, built.rows, {
      title: "Toynk", link: "https://toynk.com", description: "feed",
    });
    expect((xml.match(/<item>/g) ?? []).length).toBe(2);
    expect(xml).toContain("<g:id>PHM-RCK-SM</g:id>");
    expect(xml).toContain("<g:shipping>");
  });
});
