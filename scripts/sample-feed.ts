/**
 * Emit a sample feed from fixture data so you can eyeball the output, or diff
 * it after changing the mapping, without touching a live store.
 *   npx tsx scripts/sample-feed.ts > sample-feed.csv
 */
import { buildRows } from "../src/cj/transform";
import { toDelimited } from "../src/cj/serialize";
import { validateRows, summarize } from "../src/cj/validate";
import type { FeedOptions, ShopifyProduct } from "../src/cj/types";

const options: FeedOptions = {
  currency: "USD",
  targetCountry: "US",
  condition: "new",
  linkUtm: "utm_source=cj&utm_medium=affiliate",
  flatShippingPrice: "0",
  shippingCountry: "US",
  taxRate: null,
  colorOptionName: "Color",
  sizeOptionName: "Size",
  ageGroup: null,
  metafieldNamespace: "cj",
  mappingOverrides: {},
  customLabels: { custom_label_0: "TAG_PREFIX:season-" },
  includeOutOfStock: true,
  excludeTags: [],
  includeTags: [],
  excludeVendors: [],
  minPrice: null,
  maxRows: null,
};

const products: ShopifyProduct[] = [
  {
    id: "gid://shopify/Product/9001",
    handle: "rocky-plush",
    title: "Project Hail Mary Rocky Plush",
    descriptionHtml: '<p>An <em>Eridian</em> friend.</p><ul><li>12" tall</li></ul>',
    vendor: "Toynk",
    productType: "Plush",
    tags: ["scifi", "season-holiday"],
    status: "ACTIVE",
    onlineStoreUrl: "https://toynk.com/products/rocky-plush",
    publishedAt: "2026-02-01T00:00:00Z",
    isGiftCard: false,
    categoryFullName: "Toys & Games > Toys > Stuffed Animals",
    images: [
      { url: "https://cdn.toynk.com/rocky-main.jpg" },
      { url: "https://cdn.toynk.com/rocky-side.jpg" },
    ],
    metafields: { gpc: "1253" },
    variants: [
      {
        id: "gid://shopify/ProductVariant/501", sku: "PHM-RCK-SM", barcode: "0850041234567",
        title: "Small", price: "19.99", compareAtPrice: "24.99", availableForSale: true,
        inventoryQuantity: 42, inventoryPolicy: "DENY", taxable: true,
        selectedOptions: [{ name: "Size", value: "Small" }], images: [],
        weight: { value: 0.4, unit: "POUNDS" },
      },
      {
        id: "gid://shopify/ProductVariant/502", sku: "PHM-RCK-LG", barcode: "0850041234574",
        title: "Large", price: "34.99", compareAtPrice: null, availableForSale: false,
        inventoryQuantity: 0, inventoryPolicy: "DENY", taxable: true,
        selectedOptions: [{ name: "Size", value: "Large" }], images: [],
        weight: { value: 0.9, unit: "POUNDS" },
      },
    ],
  },
];

const built = buildRows(products, options);
const issues = [...built.issues, ...validateRows(built.columns, built.rows)];
process.stderr.write(
  `${built.rowsWritten} rows, ${built.rowsRejected} rejected. ${JSON.stringify(summarize(issues))}\n`,
);
process.stdout.write(toDelimited(built.columns, built.rows, ",", true));
