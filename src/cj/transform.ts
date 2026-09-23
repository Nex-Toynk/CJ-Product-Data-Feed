import {
  AVAILABILITY_VALUES,
  CJ_FIELDS,
  ID_ALLOWED,
  shippingHeader,
  SHIPPING_SUBATTRS,
  taxHeader,
  TAX_SUBATTRS,
} from "./spec";
import type {
  BuildResult,
  CjRow,
  FeedOptions,
  RowIssue,
  ShopifyProduct,
  ShopifyVariant,
} from "./types";
import { appendQuery, htmlToText, money, normalizeGtin, truncate, uniq } from "./text";

const DEFAULT_VARIANT_TITLE = "Default Title";

/** How many individual issues to keep as a readable sample. Counts are uncapped. */
const ISSUE_SAMPLE_LIMIT = 500;

/**
 * Source expressions usable in `mappingOverrides` / `customLabels`.
 *   LITERAL:<text>     fixed value
 *   METAFIELD:<key>    product metafield in the configured namespace
 *   TAG_PREFIX:<p>     first product tag starting with <p>, with <p> stripped
 *   HAS_TAG:<t>        "yes" when the product carries tag <t>, else ""
 *   FIELD:<name>       a product/variant field: vendor, productType, handle,
 *                      category, status, title, sku, barcode, price,
 *                      compareAtPrice, inventoryQuantity, variantTitle
 */
export function resolveExpression(
  expr: string,
  product: ShopifyProduct,
  variant: ShopifyVariant,
): string {
  const idx = expr.indexOf(":");
  const kind = (idx === -1 ? expr : expr.slice(0, idx)).toUpperCase();
  const arg = idx === -1 ? "" : expr.slice(idx + 1);

  switch (kind) {
    case "LITERAL":
      return arg;
    case "METAFIELD":
      return product.metafields[arg] ?? "";
    case "TAG_PREFIX": {
      const hit = product.tags.find((t) => t.toLowerCase().startsWith(arg.toLowerCase()));
      return hit ? hit.slice(arg.length).trim() : "";
    }
    case "HAS_TAG":
      return product.tags.some((t) => t.toLowerCase() === arg.toLowerCase()) ? "yes" : "";
    case "FIELD":
      switch (arg) {
        case "vendor": return product.vendor ?? "";
        case "productType": return product.productType ?? "";
        case "handle": return product.handle;
        case "category": return product.categoryFullName ?? "";
        case "status": return product.status ?? "";
        case "title": return product.title;
        case "sku": return variant.sku ?? "";
        case "barcode": return variant.barcode ?? "";
        case "price": return variant.price;
        case "compareAtPrice": return variant.compareAtPrice ?? "";
        case "inventoryQuantity": return String(variant.inventoryQuantity ?? "");
        case "variantTitle": return variant.title;
        default: return "";
      }
    default:
      // Unprefixed strings are treated as literals so simple configs just work.
      return expr;
  }
}

function optionValue(variant: ShopifyVariant, name: string | null | undefined) {
  if (!name) return "";
  const hit = variant.selectedOptions.find(
    (o) => o.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  return hit?.value ?? "";
}

/** `title` should identify the variant, not just the product. */
function variantTitle(product: ShopifyProduct, variant: ShopifyVariant): string {
  if (!variant.title || variant.title === DEFAULT_VARIANT_TITLE) return product.title;
  return `${product.title} - ${variant.title}`;
}

/**
 * CJ, like Google, wants `price` to be the regular price and `sale_price` the
 * discounted one. Shopify stores it the other way round: `price` is what the
 * customer pays and `compareAtPrice` is the struck-through original.
 */
function prices(variant: ShopifyVariant): { price: string | null; salePrice: string | null } {
  const current = money(variant.price);
  const compare = money(variant.compareAtPrice);
  if (current && compare && Number(compare) > Number(current)) {
    return { price: compare, salePrice: current };
  }
  return { price: current, salePrice: null };
}

function availability(variant: ShopifyVariant, product: ShopifyProduct): string {
  if (product.publishedAt && new Date(product.publishedAt) > new Date()) return "preorder";
  if (variant.availableForSale) return "in stock";
  // Oversell-enabled variants keep selling at zero inventory.
  if ((variant.inventoryPolicy ?? "").toUpperCase() === "CONTINUE") return "in stock";
  return "out of stock";
}

function weightString(variant: ShopifyVariant): string {
  const w = variant.weight;
  if (!w || !Number.isFinite(w.value) || w.value <= 0) return "";
  const unit = ({ POUNDS: "lb", OUNCES: "oz", GRAMS: "g", KILOGRAMS: "kg" } as Record<string, string>)[
    w.unit?.toUpperCase() ?? ""
  ];
  return unit ? `${Number(w.value.toFixed(2))} ${unit}` : "";
}

function productLink(
  product: ShopifyProduct,
  variant: ShopifyVariant,
  opts: FeedOptions,
): string | null {
  if (!product.onlineStoreUrl) return null;
  const variantId = variant.id.split("/").pop();
  const withVariant =
    product.variants.length > 1 && variantId
      ? appendQuery(product.onlineStoreUrl, `variant=${variantId}`)
      : product.onlineStoreUrl;
  return appendQuery(withVariant, opts.linkUtm);
}

function passesFilters(product: ShopifyProduct, opts: FeedOptions): string | null {
  if (product.isGiftCard) return "gift card";
  const tags = product.tags.map((t) => t.toLowerCase());
  if (opts.excludeTags.length && opts.excludeTags.some((t) => tags.includes(t.toLowerCase()))) {
    return "excluded tag";
  }
  if (opts.includeTags.length && !opts.includeTags.some((t) => tags.includes(t.toLowerCase()))) {
    return "missing required tag";
  }
  if (
    opts.excludeVendors.length &&
    opts.excludeVendors.some((v) => v.toLowerCase() === (product.vendor ?? "").toLowerCase())
  ) {
    return "excluded vendor";
  }
  return null;
}

/** Columns this configuration will emit, in a stable order. */
export function feedColumns(opts: FeedOptions): string[] {
  const cols = CJ_FIELDS.map((f) => f.name);
  const out = cols.filter((c) => {
    if (c.startsWith("custom_label_")) return Boolean(opts.customLabels[c]);
    if (c === "age_group") return Boolean(opts.ageGroup) || Boolean(opts.mappingOverrides.age_group);
    return true;
  });
  out.push(shippingHeader(SHIPPING_SUBATTRS));
  if (opts.taxRate) out.push(taxHeader(TAX_SUBATTRS));
  return out;
}

/** Build one CJ row per sellable variant. */
export function buildRows(products: ShopifyProduct[], opts: FeedOptions): BuildResult {
  const rows: CjRow[] = [];
  const issues: RowIssue[] = [];
  const issueCountsByField: Record<string, number> = {};
  const productsSkipped: Record<string, number> = {};
  const seenIds = new Map<string, string>();
  let rowsRejected = 0;
  let rowsWarned = 0;
  let totalIssues = 0;
  // Set per variant, so a warned row is counted once however many warnings it
  // collected — and counted even after the issue sample above has filled up.
  let rowHasWarning = false;

  const record = (issue: RowIssue) => {
    totalIssues += 1;
    issueCountsByField[issue.field] = (issueCountsByField[issue.field] ?? 0) + 1;
    if (issues.length < ISSUE_SAMPLE_LIMIT) issues.push(issue);
  };
  const reject = (id: string, field: string, message: string) => {
    rowsRejected += 1;
    record({ id, field, level: "reject", stage: "build", message });
  };
  const warn = (id: string, field: string, message: string) => {
    rowHasWarning = true;
    record({ id, field, level: "warn", stage: "build", message });
  };

  const columns = feedColumns(opts);
  const shippingCol = shippingHeader(SHIPPING_SUBATTRS);
  const taxCol = taxHeader(TAX_SUBATTRS);

  for (const product of products) {
    const skipReason = passesFilters(product, opts);
    if (skipReason) {
      productsSkipped[skipReason] = (productsSkipped[skipReason] ?? 0) + 1;
      continue;
    }

    for (const variant of product.variants) {
      rowHasWarning = false;
      const rawId = variant.sku?.trim() || `${product.handle}-${variant.id.split("/").pop()}`;
      const id = truncate(rawId.replace(ID_ALLOWED, "-"), 50);

      if (!id) {
        reject(rawId || product.handle, "id", "No SKU and no usable fallback identifier");
        continue;
      }
      const claimedBy = seenIds.get(id);
      if (claimedBy) {
        reject(
          id,
          "id",
          `Duplicate id — CJ drops every product sharing an id. Already used by ${claimedBy}`,
        );
        continue;
      }

      const { price, salePrice } = prices(variant);
      if (!price) {
        reject(id, "price", `Unparseable price "${variant.price}"`);
        continue;
      }
      if (opts.minPrice != null && Number(price) < opts.minPrice) continue;

      const avail = availability(variant, product);
      if (!opts.includeOutOfStock && avail === "out of stock") continue;
      if (!AVAILABILITY_VALUES.includes(avail as (typeof AVAILABILITY_VALUES)[number])) {
        reject(id, "availability", `Invalid availability "${avail}"`);
        continue;
      }

      const link = productLink(product, variant, opts);
      if (!link) {
        reject(id, "link", "Product has no online store URL — not published to Online Store");
        continue;
      }

      const description = truncate(htmlToText(product.descriptionHtml), 5000);
      if (!description) {
        reject(id, "description", "Empty description — CJ rejects rows without one");
        continue;
      }

      const title = truncate(variantTitle(product, variant), 150);
      const brand = truncate((product.vendor ?? "").trim(), 70);
      const gtin = normalizeGtin(variant.barcode);
      const mpn = truncate((variant.sku ?? "").trim(), 70);

      if (variant.barcode && !gtin) {
        warn(id, "gtin", `Barcode "${variant.barcode}" is not a valid 8/10-14 digit GTIN — omitted`);
      }

      // CJ rejects a row that has neither brand+gtin nor brand+mpn unless we
      // say so explicitly.
      const hasIdentifier = Boolean(brand) && (Boolean(gtin) || Boolean(mpn));
      const identifierExists = hasIdentifier ? "yes" : "no";
      if (!hasIdentifier) {
        warn(id, "identifier_exists", "No brand+GTIN or brand+MPN — sending identifier_exists=no");
      }

      const images = uniq([
        ...variant.images.map((i) => i.url),
        ...product.images.map((i) => i.url),
      ]).filter(Boolean);
      if (images.length === 0) {
        warn(id, "image_link", "No image — publishers cannot merchandise this product");
      }

      const row: CjRow = {
        id,
        title,
        description,
        link: truncate(link, 2000),
        image_link: images[0] ? truncate(images[0], 2000) : "",
        additional_image_link: images.slice(1, 11).join(","),
        mobile_link: "",
        availability: avail,
        availability_date: "",
        expiration_date: "",
        price: `${price} ${opts.currency}`,
        sale_price: salePrice ? `${salePrice} ${opts.currency}` : "",
        sale_price_effective_date: "",
        cost_of_goods_sold: "",
        brand,
        gtin: gtin ?? "",
        mpn,
        identifier_exists: identifierExists,
        condition: opts.condition,
        google_product_category: "",
        product_type: truncate(product.productType ?? product.categoryFullName ?? "", 750),
        item_group_id:
          product.variants.length > 1 ? truncate(product.id.split("/").pop() ?? "", 50) : "",
        color: truncate(optionValue(variant, opts.colorOptionName), 100),
        size: truncate(optionValue(variant, opts.sizeOptionName), 100),
        size_type: "",
        size_system: "",
        age_group: opts.ageGroup ?? "",
        gender: "",
        material: "",
        pattern: "",
        multipack: "",
        is_bundle: "",
        adult: "",
        product_weight: weightString(variant),
        shipping_weight: weightString(variant),
        ships_from_country: opts.targetCountry,
        [shippingCol]: [
          opts.shippingCountry,
          "",
          opts.flatShippingPrice ? `${money(opts.flatShippingPrice) ?? "0.00"} ${opts.currency}` : "",
        ].join(":"),
      };

      if (opts.taxRate) {
        row[taxCol] = [opts.taxRate, opts.shippingCountry, "no"].join(":");
      }

      // Per-product Google category: metafield first, then Shopify taxonomy.
      const gpcMetafield = product.metafields["google_product_category"] ?? product.metafields["gpc"];
      if (gpcMetafield) row.google_product_category = gpcMetafield;

      for (const [field, expr] of Object.entries(opts.mappingOverrides)) {
        if (!expr) continue;
        row[field] = resolveExpression(expr, product, variant);
      }
      for (const [label, expr] of Object.entries(opts.customLabels)) {
        if (!expr) continue;
        row[label] = truncate(resolveExpression(expr, product, variant), 100);
      }

      if (!row.google_product_category) {
        warn(id, "google_product_category", "Missing — CJ Insights product reporting needs it");
      }

      if (rowHasWarning) rowsWarned += 1;

      seenIds.set(id, `${product.handle} (${variant.title})`);
      rows.push(row);

      if (opts.maxRows && rows.length >= opts.maxRows) {
        return finish();
      }
    }
  }

  return finish();

  function finish(): BuildResult {
    return {
      rows,
      columns,
      productsSeen: products.length,
      rowsWritten: rows.length,
      rowsRejected,
      rowsWarned,
      issues,
      issuesTruncated: totalIssues > issues.length,
      issueCountsByField,
      productsSkipped,
    };
  }
}
