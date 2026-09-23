import { describe, expect, it } from "vitest";
import { streamProducts } from "../src/shopify/jsonl";

function stream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.join("\n") + "\n";
  // Deliberately split mid-line to prove the chunk buffering works.
  const chunks = [text.slice(0, 37), text.slice(37, 120), text.slice(120)];
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) if (c) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const PRODUCT = JSON.stringify({
  __typename: "Product",
  id: "gid://shopify/Product/1",
  handle: "rocky",
  title: "Rocky",
  descriptionHtml: "<p>Hi</p>",
  vendor: "Toynk",
  tags: ["a"],
  onlineStoreUrl: "https://s.example/products/rocky",
  featuredMedia: { preview: { image: { url: "https://cdn/f.jpg", altText: null } } },
});

const VARIANT_A = JSON.stringify({
  __typename: "ProductVariant",
  id: "gid://shopify/ProductVariant/10",
  sku: "A",
  price: "9.99",
  availableForSale: true,
  selectedOptions: [{ name: "Color", value: "Red" }],
  inventoryItem: { measurement: { weight: { unit: "POUNDS", value: 1.25 } } },
  __parentId: "gid://shopify/Product/1",
});

const METAFIELD = JSON.stringify({
  __typename: "Metafield",
  namespace: "cj",
  key: "gpc",
  value: "1253",
  __parentId: "gid://shopify/Product/1",
});

const PRODUCT_IMAGE = JSON.stringify({
  __typename: "MediaImage",
  image: { url: "https://cdn/p2.jpg" },
  __parentId: "gid://shopify/Product/1",
});

const VARIANT_IMAGE = JSON.stringify({
  __typename: "MediaImage",
  image: { url: "https://cdn/v.jpg" },
  __parentId: "gid://shopify/ProductVariant/10",
});

const PRODUCT_2 = JSON.stringify({
  __typename: "Product",
  id: "gid://shopify/Product/2",
  handle: "second",
  title: "Second",
  tags: [],
});

async function collect(lines: string[]) {
  const out = [];
  for await (const p of streamProducts(stream(lines))) out.push(p);
  return out;
}

describe("streamProducts", () => {
  it("assembles products, variants, metafields and images from JSONL", async () => {
    const products = await collect([PRODUCT, VARIANT_A, METAFIELD, PRODUCT_IMAGE, VARIANT_IMAGE, PRODUCT_2]);

    expect(products).toHaveLength(2);
    const [first, second] = products;

    expect(first.id).toBe("gid://shopify/Product/1");
    expect(first.title).toBe("Rocky");
    expect(first.metafields.gpc).toBe("1253");
    // Featured image first, then the extra product media.
    expect(first.images.map((i) => i.url)).toEqual(["https://cdn/f.jpg", "https://cdn/p2.jpg"]);

    expect(first.variants).toHaveLength(1);
    expect(first.variants[0].sku).toBe("A");
    expect(first.variants[0].images.map((i) => i.url)).toEqual(["https://cdn/v.jpg"]);
    expect(first.variants[0].weight).toEqual({ value: 1.25, unit: "POUNDS" });
    expect(first.variants[0].selectedOptions[0].value).toBe("Red");

    expect(second.handle).toBe("second");
    expect(second.variants).toHaveLength(0);
  });

  it("ignores unparseable lines instead of aborting the run", async () => {
    const products = await collect([PRODUCT, "{not json", VARIANT_A]);
    expect(products).toHaveLength(1);
    expect(products[0].variants).toHaveLength(1);
  });

  it("returns nothing for an empty result", async () => {
    expect(await collect([])).toEqual([]);
  });
});
