import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedError, runFeed } from "../src/run";
import type { AdminClient } from "../src/shopify/bulk";
import type { FeedConfigFile, Secrets } from "../src/config";

const BULK_URL = "https://storage.example/bulk-result.jsonl";

const CONFIG: FeedConfigFile = {
  fileName: "toynk-product-feed.csv",
  delivery: "sftp",
  hostedPathPrefix: "",
  format: "CSV",
  quotedValues: true,
  currency: "USD",
  targetCountry: "US",
  condition: "new",
  linkUtm: "utm_source=cj",
  flatShippingPrice: "0",
  shippingCountry: "US",
  taxRate: null,
  colorOptionName: "Color",
  sizeOptionName: "Size",
  ageGroup: null,
  metafieldNamespace: "cj",
  includeDraft: false,
  requireOnlineStore: true,
  includeOutOfStock: true,
  excludeTags: [],
  includeTags: [],
  excludeVendors: [],
  minPrice: null,
  maxRows: null,
  mappingOverrides: {},
  customLabels: {},
  minRows: 1,
  maxRejectRate: 0.5,
};

const SECRETS: Secrets = {
  shop: "toynk.myshopify.com",
  auth: { kind: "client_credentials", clientId: "id", clientSecret: "secret" } as const,
  apiVersion: "2026-07",
  sftp: null,
};

function product(id: number, sku: string, extra: Record<string, unknown> = {}) {
  return [
    JSON.stringify({
      __typename: "Product",
      id: `gid://shopify/Product/${id}`,
      handle: `p-${id}`,
      title: `Product ${id}`,
      descriptionHtml: "<p>A thing.</p>",
      vendor: "Toynk",
      productType: "Plush",
      tags: [],
      onlineStoreUrl: `https://toynk.com/products/p-${id}`,
      featuredMedia: { preview: { image: { url: `https://cdn/${id}.jpg` } } },
      ...extra,
    }),
    JSON.stringify({
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${id}0`,
      sku,
      barcode: "012345678905",
      title: "Default Title",
      price: "10.00",
      availableForSale: true,
      inventoryPolicy: "DENY",
      selectedOptions: [],
      __parentId: `gid://shopify/Product/${id}`,
    }),
  ];
}

/** A Shopify Admin API stub that plays out one bulk operation. */
function stubAdmin(opts: {
  jsonl: string[];
  currentBulk?: { id: string; status: string; createdAt: string } | null;
  finalStatus?: string;
  url?: string | null;
}): { admin: AdminClient; calls: string[] } {
  const calls: string[] = [];
  let cancelled = false;

  const admin: AdminClient = {
    async graphql(query: string) {
      const json = (data: unknown) =>
        new Response(JSON.stringify({ data }), {
          headers: { "Content-Type": "application/json" },
        });

      if (query.includes("CjFeedCurrentBulk")) {
        calls.push("current");
        return json({ currentBulkOperation: cancelled ? null : (opts.currentBulk ?? null) });
      }
      if (query.includes("CjFeedBulkCancel")) {
        calls.push("cancel");
        cancelled = true;
        return json({ bulkOperationCancel: { bulkOperation: { id: "x", status: "CANCELED" }, userErrors: [] } });
      }
      if (query.includes("CjFeedBulkStart")) {
        calls.push("start");
        return json({
          bulkOperationRunQuery: {
            bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" },
            userErrors: [],
          },
        });
      }
      if (query.includes("CjFeedBulkById")) {
        calls.push("poll");
        return json({
          node: {
            id: "gid://shopify/BulkOperation/1",
            status: opts.finalStatus ?? "COMPLETED",
            errorCode: null,
            objectCount: String(opts.jsonl.length),
            fileSize: "1024",
            url: opts.url === undefined ? BULK_URL : opts.url,
            partialDataUrl: null,
            completedAt: new Date().toISOString(),
          },
        });
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    },
  };

  return { admin, calls };
}

function stubFetch(jsonl: string[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url !== BULK_URL) throw new Error(`Unexpected fetch ${url}`);
    return new Response(jsonl.join("\n") + "\n");
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("runFeed", () => {
  it("runs the whole pipeline and writes the feed in dry-run mode", async () => {
    const jsonl = [...product(1, "SKU-1"), ...product(2, "SKU-2")];
    stubFetch(jsonl);
    const { admin, calls } = stubAdmin({ jsonl });
    const dir = mkdtempSync(join(tmpdir(), "cjrun-"));
    const outPath = join(dir, "feed.csv");

    const result = await runFeed({
      config: CONFIG, secrets: SECRETS, admin, dryRun: true, outPath,
    });

    expect(calls).toContain("start");
    expect(calls).toContain("poll");
    expect(result.productsSeen).toBe(2);
    expect(result.rowsWritten).toBe(2);
    expect(result.deliveredTo).toBeNull();
    expect(result.outPath).toBe(outPath);

    const csv = readFileSync(outPath, "utf8").trim().split("\n");
    expect(csv).toHaveLength(3);
    expect(csv[0].split(",")[0]).toBe("id");
    expect(csv[1]).toContain("SKU-1");
  });

  it("cancels a bulk operation left running by a previous run", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin, calls } = stubAdmin({
      jsonl,
      currentBulk: { id: "gid://shopify/BulkOperation/0", status: "RUNNING", createdAt: "2026-09-20T00:00:00Z" },
    });

    await runFeed({ config: CONFIG, secrets: SECRETS, admin, dryRun: true });
    expect(calls).toContain("cancel");
    expect(calls.indexOf("cancel")).toBeLessThan(calls.indexOf("start"));
  }, 30_000);

  it("refuses to deliver when too few rows survive", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });

    await expect(
      runFeed({ config: { ...CONFIG, minRows: 500 }, secrets: SECRETS, admin, dryRun: true }),
    ).rejects.toThrow(/below minRows=500/);
  });

  it("refuses to deliver when the reject rate is too high", async () => {
    // Two products, one with no storefront URL — a 50% reject rate.
    const jsonl = [
      ...product(1, "SKU-1"),
      ...product(2, "SKU-2", { onlineStoreUrl: null }),
    ];
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });

    await expect(
      runFeed({ config: { ...CONFIG, maxRejectRate: 0.1 }, secrets: SECRETS, admin, dryRun: true }),
    ).rejects.toThrow(/above maxRejectRate/);
  });

  it("fails loudly when the bulk operation does not complete", async () => {
    stubFetch([]);
    const { admin } = stubAdmin({ jsonl: [], finalStatus: "FAILED" });

    await expect(
      runFeed({ config: CONFIG, secrets: SECRETS, admin, dryRun: true }),
    ).rejects.toThrow(FeedError);
  });

  it("explains an empty result rather than delivering nothing", async () => {
    stubFetch([]);
    const { admin } = stubAdmin({ jsonl: [], url: null });

    await expect(
      runFeed({ config: CONFIG, secrets: SECRETS, admin, dryRun: true }),
    ).rejects.toThrow(/no products matched the filters/);
  });

  it("will not silently skip delivery when SFTP is missing and it is not a dry run", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });

    await expect(
      runFeed({ config: CONFIG, secrets: SECRETS, admin, dryRun: false }),
    ).rejects.toThrow(/No SFTP credentials/);
  });
});


describe("hosted delivery", () => {
  it("treats writing the file as the delivery, with no SFTP configured", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });
    const dir = mkdtempSync(join(tmpdir(), "cjhost-"));
    const outPath = join(dir, "feed.csv");

    const result = await runFeed({
      config: { ...CONFIG, delivery: "hosted" },
      secrets: SECRETS, // sftp is null
      admin,
      dryRun: false,
      outPath,
    });

    expect(result.deliveredTo).toBe(`hosted:${outPath}`);
    expect(readFileSync(outPath, "utf8")).toContain("SKU-1");
  });

  it("refuses hosted delivery with nowhere to write", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });

    await expect(
      runFeed({ config: { ...CONFIG, delivery: "hosted" }, secrets: SECRETS, admin, dryRun: false }),
    ).rejects.toThrow(/no output path was given/);
  });

  it("still demands SFTP credentials when delivery is sftp", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });

    await expect(
      runFeed({ config: CONFIG, secrets: SECRETS, admin, dryRun: false }),
    ).rejects.toThrow(/No SFTP credentials/);
  });
});

describe("keeping the hosted prefix out of logs", () => {
  it("redacts the path prefix from log lines and the delivery record", async () => {
    const jsonl = product(1, "SKU-1");
    stubFetch(jsonl);
    const { admin } = stubAdmin({ jsonl });
    const dir = mkdtempSync(join(tmpdir(), "cjredact-"));
    const outPath = join(dir, "s3cretSlug", "feed.csv");
    const lines: string[] = [];

    const result = await runFeed({
      config: { ...CONFIG, delivery: "hosted", hostedPathPrefix: "s3cretSlug" },
      secrets: SECRETS,
      admin,
      dryRun: false,
      outPath,
      log: (m) => lines.push(m),
    });

    // A public repo's Actions log must not carry the one string protecting the URL.
    expect(lines.join("\n")).not.toContain("s3cretSlug");
    expect(lines.some((l) => l.includes("***"))).toBe(true);
    expect(result.deliveredTo).not.toContain("s3cretSlug");
    // The file still goes to the real path.
    expect(readFileSync(outPath, "utf8")).toContain("SKU-1");
  });
});
