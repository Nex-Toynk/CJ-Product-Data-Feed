/** A single output row: CJ column name -> value (already stringified). */
export type CjRow = Record<string, string>;

export interface FeedOptions {
  currency: string;
  targetCountry: string;
  condition: string;
  linkUtm?: string | null;
  flatShippingPrice?: string | null;
  shippingCountry: string;
  taxRate?: string | null;
  colorOptionName?: string | null;
  sizeOptionName?: string | null;
  ageGroup?: string | null;
  metafieldNamespace: string;
  /** cjField -> source expression, e.g. { google_product_category: "METAFIELD:gpc" } */
  mappingOverrides: Record<string, string>;
  /** custom_label_N -> source expression */
  customLabels: Record<string, string>;
  /** Product selection */
  includeOutOfStock: boolean;
  excludeTags: string[];
  includeTags: string[];
  excludeVendors: string[];
  minPrice?: number | null;
  maxRows?: number | null;
}

export interface ShopifyImage {
  url: string;
  altText?: string | null;
}

export interface ShopifyVariant {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  title: string;
  price: string;
  compareAtPrice?: string | null;
  availableForSale: boolean;
  inventoryQuantity?: number | null;
  inventoryPolicy?: string | null;
  taxable?: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
  images: ShopifyImage[];
  weight?: { value: number; unit: string } | null;
}

export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  descriptionHtml?: string | null;
  vendor?: string | null;
  productType?: string | null;
  tags: string[];
  status?: string | null;
  onlineStoreUrl?: string | null;
  publishedAt?: string | null;
  isGiftCard?: boolean;
  categoryFullName?: string | null;
  images: ShopifyImage[];
  metafields: Record<string, string>;
  variants: ShopifyVariant[];
}

export type IssueLevel = "reject" | "warn";

/**
 * Where an issue was raised, which decides what it means:
 *   "build"    — the mapper. A `reject` here means the row is NOT in the feed.
 *   "validate" — the post-write check. A `reject` here means the row IS in the
 *                feed but CJ is expected to refuse it.
 */
export type IssueStage = "build" | "validate";

export interface RowIssue {
  id: string;
  field: string;
  level: IssueLevel;
  stage: IssueStage;
  message: string;
}

export interface BuildResult {
  rows: CjRow[];
  columns: string[];
  productsSeen: number;
  rowsWritten: number;
  rowsRejected: number;
  rowsWarned: number;
  /**
   * A capped SAMPLE of issues, for display. Never use its length as a count —
   * `issueCountsByField` and the row counters above are the real figures.
   */
  issues: RowIssue[];
  /** True when more issues occurred than `issues` holds. */
  issuesTruncated: boolean;
  /** Uncapped count of issues per field. */
  issueCountsByField: Record<string, number>;
  /**
   * Products removed by a filter, keyed by reason. Worth logging on every run:
   * a mis-set excludeTags can quietly shrink the feed, and the row count alone
   * does not say why.
   */
  productsSkipped: Record<string, number>;
}
