import type { ShopifyImage, ShopifyProduct, ShopifyVariant } from "../cj/types";

interface JsonlNode {
  __typename?: string;
  id?: string;
  __parentId?: string;
  [key: string]: unknown;
}

/**
 * Stream a bulk-operation JSONL response into assembled products.
 *
 * Shopify guarantees a child line always follows its parent, so we can build
 * incrementally and emit a product as soon as the next top-level product line
 * arrives. That keeps memory flat for large catalogues instead of holding the
 * whole JSONL in an array.
 */
export async function* streamProducts(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ShopifyProduct> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let current: ShopifyProduct | null = null;
  // variant gid -> variant, so MediaImage children can attach to the right one
  let variantsById = new Map<string, ShopifyVariant>();

  const flush = (): ShopifyProduct | null => {
    const done = current;
    current = null;
    variantsById = new Map();
    return done;
  };

  const handle = function* (line: string): Generator<ShopifyProduct> {
    if (!line.trim()) return;
    let node: JsonlNode;
    try {
      node = JSON.parse(line) as JsonlNode;
    } catch {
      return; // a truncated final line; the caller checks counts
    }

    const parentId = node.__parentId as string | undefined;

    if (!parentId) {
      const previous = flush();
      if (previous) yield previous;
      current = toProduct(node);
      return;
    }
    if (!current) return;

    const type = node.__typename;

    if (type === "ProductVariant") {
      const variant = toVariant(node);
      variantsById.set(variant.id, variant);
      current.variants.push(variant);
      return;
    }
    if (type === "Metafield") {
      const key = String(node.key ?? "");
      if (key) current.metafields[key] = String(node.value ?? "");
      return;
    }
    if (type === "MediaImage") {
      const image = toImage(node.image);
      if (!image) return;
      const owner = variantsById.get(parentId);
      if (owner) owner.images.push(image);
      else current.images.push(image);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield* handle(line);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* handle(buffer);

  const last = flush();
  if (last) yield last;
}

function toImage(raw: unknown): ShopifyImage | null {
  if (!raw || typeof raw !== "object") return null;
  const img = raw as { url?: string; altText?: string | null };
  return img.url ? { url: img.url, altText: img.altText ?? null } : null;
}

function toProduct(node: JsonlNode): ShopifyProduct {
  const featured = (node.featuredMedia as { preview?: { image?: unknown } } | undefined)?.preview
    ?.image;
  const featuredImage = toImage(featured);
  const category = node.category as { fullName?: string } | undefined;

  return {
    id: String(node.id ?? ""),
    handle: String(node.handle ?? ""),
    title: String(node.title ?? ""),
    descriptionHtml: (node.descriptionHtml as string | null) ?? null,
    vendor: (node.vendor as string | null) ?? null,
    productType: (node.productType as string | null) ?? null,
    tags: Array.isArray(node.tags) ? (node.tags as string[]) : [],
    status: (node.status as string | null) ?? null,
    onlineStoreUrl: (node.onlineStoreUrl as string | null) ?? null,
    publishedAt: (node.publishedAt as string | null) ?? null,
    isGiftCard: Boolean(node.isGiftCard),
    categoryFullName: category?.fullName ?? null,
    // The featured image leads so it becomes image_link.
    images: featuredImage ? [featuredImage] : [],
    metafields: {},
    variants: [],
  };
}

function toVariant(node: JsonlNode): ShopifyVariant {
  const measurement = (node.inventoryItem as { measurement?: { weight?: { unit?: string; value?: number } } } | undefined)
    ?.measurement?.weight;

  return {
    id: String(node.id ?? ""),
    sku: (node.sku as string | null) ?? null,
    barcode: (node.barcode as string | null) ?? null,
    title: String(node.title ?? ""),
    price: String(node.price ?? ""),
    compareAtPrice: (node.compareAtPrice as string | null) ?? null,
    availableForSale: Boolean(node.availableForSale),
    inventoryQuantity: (node.inventoryQuantity as number | null) ?? null,
    inventoryPolicy: (node.inventoryPolicy as string | null) ?? null,
    taxable: Boolean(node.taxable),
    selectedOptions: Array.isArray(node.selectedOptions)
      ? (node.selectedOptions as Array<{ name: string; value: string }>)
      : [],
    images: [],
    weight:
      measurement && typeof measurement.value === "number"
        ? { value: measurement.value, unit: String(measurement.unit ?? "") }
        : null,
  };
}
