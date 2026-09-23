/**
 * CJ Affiliate — "Shopping (Google Format)" product feed specification.
 *
 * Source: CJ Developer Portal → Data Imports → Product Feeds
 * https://developers.cj.com/docs/data-imports/product-feeds
 *
 * CJ's Shopping feed follows the Google Merchant Center attribute set. Notable
 * differences from GMC that this file encodes:
 *   - no account header rows; the header line is just the column names
 *   - column order is free, but column *names* must match exactly
 *   - compound fields (shipping, tax, certification) declare their sub-attributes
 *     in the header, colon-separated: `shipping(country:postal_code:service:price)`
 *   - AdWords-only fields are accepted but discarded by CJ
 */

export type Requirement = "required" | "conditional" | "optional";

export interface CjField {
  /** Column name exactly as CJ expects it. */
  name: string;
  requirement: Requirement;
  /** Max characters CJ stores; longer values are truncated or rejected. */
  maxLength?: number;
  /** Allowed values, when CJ constrains them. */
  enum?: readonly string[];
  /** If true, a bad value gets the row REJECTED. If false, the value is dropped. */
  rejectsRow?: boolean;
  notes?: string;
}

export const AVAILABILITY_VALUES = [
  "in stock",
  "out of stock",
  "preorder",
  "backorder",
] as const;

export const CONDITION_VALUES = ["new", "refurbished", "used"] as const;

export const AGE_GROUP_VALUES = [
  "newborn",
  "infant",
  "toddler",
  "kids",
  "adult",
] as const;

export const GENDER_VALUES = ["male", "female", "unisex"] as const;

export const SIZE_TYPE_VALUES = [
  "regular",
  "petite",
  "plus",
  "big and tall",
  "maternity",
] as const;

export const SIZE_SYSTEM_VALUES = [
  "US", "UK", "EU", "DE", "FR", "JP", "CN", "IT", "BR", "MEX", "AU",
] as const;

/**
 * The fields this app can emit, in the order they are written to the file.
 * (CJ allows any order; a stable order keeps diffs between runs readable.)
 */
export const CJ_FIELDS: readonly CjField[] = [
  { name: "id", requirement: "required", maxLength: 50, rejectsRow: true,
    notes: "Unique per feed. Alphanumeric plus -.#_/ only. Must match SKUs sent in transaction data for item-level commissioning." },
  { name: "title", requirement: "required", maxLength: 150, rejectsRow: true },
  { name: "description", requirement: "required", maxLength: 5000, rejectsRow: true },
  { name: "link", requirement: "required", maxLength: 2000, rejectsRow: true,
    notes: "Absolute URL including scheme." },
  { name: "image_link", requirement: "optional", maxLength: 2000,
    notes: "CJ's field table marks this optional and its field detail says a product with no valid image link is 'accepted without this value' — so a missing image is a warning, not a dropped row. Publishers still cannot merchandise it." },
  { name: "additional_image_link", requirement: "optional", maxLength: 2000,
    notes: "Up to 10, comma separated." },
  { name: "mobile_link", requirement: "optional", maxLength: 2000 },

  { name: "availability", requirement: "required", enum: AVAILABILITY_VALUES, rejectsRow: true },
  { name: "availability_date", requirement: "optional", maxLength: 25 },
  { name: "expiration_date", requirement: "optional", maxLength: 25 },

  { name: "price", requirement: "required", rejectsRow: true,
    notes: "Numeric, ISO 4217. Decimal point must be '.'; CJ reads ',' as '.'." },
  { name: "sale_price", requirement: "optional" },
  { name: "sale_price_effective_date", requirement: "optional", maxLength: 51 },
  { name: "cost_of_goods_sold", requirement: "optional" },

  { name: "brand", requirement: "conditional", maxLength: 70,
    notes: "Required unless identifier_exists is 'no'." },
  { name: "gtin", requirement: "conditional",
    notes: "8, 10, 11, 12, 13 or 14 digits. Required with brand unless mpn or identifier_exists='no'." },
  { name: "mpn", requirement: "conditional", maxLength: 70 },
  { name: "identifier_exists", requirement: "conditional", enum: ["yes", "no"],
    notes: "Set 'no' when the product has neither gtin+brand nor mpn+brand, else the row is rejected." },
  { name: "condition", requirement: "required", enum: CONDITION_VALUES, rejectsRow: true },

  { name: "google_product_category", requirement: "optional",
    notes: "Numeric ID or full Google taxonomy path. Required for Insights product reporting." },
  { name: "product_type", requirement: "optional", maxLength: 750 },

  { name: "item_group_id", requirement: "optional", maxLength: 50 },
  { name: "color", requirement: "optional", maxLength: 100 },
  { name: "size", requirement: "optional", maxLength: 100 },
  { name: "size_type", requirement: "optional", enum: SIZE_TYPE_VALUES },
  { name: "size_system", requirement: "optional", enum: SIZE_SYSTEM_VALUES },
  { name: "age_group", requirement: "optional", enum: AGE_GROUP_VALUES },
  { name: "gender", requirement: "optional", enum: GENDER_VALUES },
  { name: "material", requirement: "optional", maxLength: 200 },
  { name: "pattern", requirement: "optional", maxLength: 100 },

  { name: "multipack", requirement: "optional" },
  { name: "is_bundle", requirement: "optional", enum: ["yes", "no"] },
  { name: "adult", requirement: "optional", enum: ["yes", "no"] },

  { name: "product_weight", requirement: "optional" },
  { name: "shipping_weight", requirement: "optional" },
  { name: "ships_from_country", requirement: "optional" },

  { name: "custom_label_0", requirement: "optional", maxLength: 100 },
  { name: "custom_label_1", requirement: "optional", maxLength: 100 },
  { name: "custom_label_2", requirement: "optional", maxLength: 100 },
  { name: "custom_label_3", requirement: "optional", maxLength: 100 },
  { name: "custom_label_4", requirement: "optional", maxLength: 100 },
] as const;

export const CJ_FIELD_BY_NAME = new Map(CJ_FIELDS.map((f) => [f.name, f]));

/**
 * Compound fields. In delimited files the sub-attributes used must be declared
 * in the header; in XML they are nested elements.
 */
export const SHIPPING_SUBATTRS = ["country", "service", "price"] as const;
export const TAX_SUBATTRS = ["rate", "country", "tax_ship"] as const;

export function shippingHeader(subattrs: readonly string[] = SHIPPING_SUBATTRS) {
  return `shipping(${subattrs.join(":")})`;
}

export function taxHeader(subattrs: readonly string[] = TAX_SUBATTRS) {
  return `tax(${subattrs.join(":")})`;
}

/** Characters CJ accepts in `id`. Everything else must be stripped. */
export const ID_ALLOWED = /[^A-Za-z0-9\-.#_/]/g;

/** CJ rejects feed files over 20 GB and requires .zip above 4 GB. */
export const MAX_FEED_BYTES = 20 * 1024 * 1024 * 1024;
export const ZIP_REQUIRED_ABOVE_BYTES = 4 * 1024 * 1024 * 1024;
