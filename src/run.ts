import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildRows } from "./cj/transform";
import { contentTypeFor, DELIMITER_BY_FORMAT, toDelimited, toXml } from "./cj/serialize";
import { validateRows } from "./cj/validate";
import type { RowIssue, ShopifyProduct } from "./cj/types";
import { ZIP_REQUIRED_ABOVE_BYTES } from "./cj/spec";
import {
  clearStaleBulkOperation,
  openBulkResult,
  startProductBulkExport,
  waitForBulkOperation,
  type AdminClient,
} from "./shopify/bulk";
import { streamProducts } from "./shopify/jsonl";
import { pushToSftp } from "./deliver/sftp";
import { toFeedOptions, type FeedConfigFile, type Secrets } from "./config";

export interface RunOptions {
  config: FeedConfigFile;
  secrets: Secrets;
  admin: AdminClient;
  /** Build and write the file, but do not deliver it to CJ. */
  dryRun: boolean;
  /** Also write the feed here, for inspection or as a CI artifact. */
  outPath?: string;
  log?: (message: string) => void;
}

export interface RunResult {
  productsSeen: number;
  rowsWritten: number;
  rowsRejected: number;
  rowsWarned: number;
  bytes: number;
  issues: RowIssue[];
  deliveredTo: string | null;
  outPath: string | null;
}

export class FeedError extends Error {}

export async function runFeed(options: RunOptions): Promise<RunResult> {
  const { config, secrets, admin, dryRun } = options;
  const log = options.log ?? (() => {});
  const started = Date.now();

  await clearStaleBulkOperation(admin, log);

  log("Starting Shopify bulk product export…");
  const operation = await startProductBulkExport(admin, {
    includeDraft: config.includeDraft,
    requireOnlineStore: config.requireOnlineStore,
    metafieldNamespace: config.metafieldNamespace,
  });
  log(`Bulk operation ${operation.id} started`);

  const finished = await waitForBulkOperation(admin, operation.id, {
    onProgress: (state) =>
      log(`  …${state.status.toLowerCase()}, ${state.objectCount ?? 0} objects so far`),
  });

  if (finished.status !== "COMPLETED") {
    throw new FeedError(
      `Bulk operation ended as ${finished.status}${finished.errorCode ? ` (${finished.errorCode})` : ""}`,
    );
  }
  if (!finished.url) {
    // Shopify returns no URL when the query matched nothing at all.
    throw new FeedError(
      "Bulk operation produced no results — no products matched the filters in feed.config.json",
    );
  }
  log(`Export complete: ${finished.objectCount} objects, ${finished.fileSize} bytes`);

  const products: ShopifyProduct[] = [];
  for await (const product of streamProducts(await openBulkResult(finished.url))) {
    products.push(product);
  }
  log(`Parsed ${products.length} products`);

  const built = buildRows(products, toFeedOptions(config));
  const validatorIssues = validateRows(built.columns, built.rows);
  const issues = [...built.issues, ...validatorIssues];

  // Counts come from the uncapped tallies, never from the issue sample.
  const counts = { ...built.issueCountsByField };
  for (const issue of validatorIssues) {
    counts[issue.field] = (counts[issue.field] ?? 0) + 1;
  }
  const topFields = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const candidates = built.rowsWritten + built.rowsRejected;
  const rejectRate = candidates === 0 ? 1 : built.rowsRejected / candidates;

  // Two different things, kept apart: rows we refused to write, and rows we did
  // write that the validator expects CJ to refuse.
  const wouldBeRefused = validatorIssues.filter((i) => i.level === "reject");

  log(
    `Built ${built.rowsWritten} rows from ${built.productsSeen} products ` +
      `(${built.rowsRejected} dropped before writing, ${built.rowsWarned} written with a field omitted)`,
  );
  if (wouldBeRefused.length) {
    log(
      `${wouldBeRefused.length} written rows look likely to be refused by CJ ` +
        `(${[...new Set(wouldBeRefused.map((i) => i.field))].join(", ")})`,
    );
  }
  const skipped = Object.entries(built.productsSkipped).sort((a, b) => b[1] - a[1]);
  if (skipped.length) {
    const total = skipped.reduce((sum, [, n]) => sum + n, 0);
    log(`Filtered out ${total} products before mapping: ${skipped.map(([r, n]) => `${r} ×${n}`).join(", ")}`);
  }
  if (topFields.length) {
    log(`Problem fields: ${topFields.map(([f, n]) => `${f}×${n}`).join(", ")}`);
  }
  if (built.issuesTruncated) {
    log(`  (counts above are complete; --issues-out holds the first ${built.issues.length} in detail)`);
  }

  // Guard rails: a mapping mistake or a bad Shopify response should fail loudly
  // rather than quietly replace a good feed with a gutted one.
  if (built.rowsWritten < config.minRows) {
    throw new FeedError(
      `Only ${built.rowsWritten} rows survived, below minRows=${config.minRows}. Refusing to deliver.`,
    );
  }
  if (rejectRate > config.maxRejectRate) {
    throw new FeedError(
      `${(rejectRate * 100).toFixed(1)}% of rows were rejected, above maxRejectRate=${
        (config.maxRejectRate * 100).toFixed(1)
      }%. Refusing to deliver. Worst fields: ${topFields.map(([f, n]) => `${f}×${n}`).join(", ")}`,
    );
  }

  const body =
    config.format === "XML"
      ? toXml(built.columns, built.rows, {
          title: `${secrets.shop} product feed`,
          link: `https://${secrets.shop}`,
          description: "Product feed for CJ Affiliate",
        })
      : toDelimited(
          built.columns,
          built.rows,
          DELIMITER_BY_FORMAT[config.format] ?? ",",
          config.quotedValues,
        );

  const buffer = Buffer.from(body, "utf8");
  log(`Serialised ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB as ${contentTypeFor(config.format)}`);

  if (buffer.byteLength > ZIP_REQUIRED_ABOVE_BYTES) {
    throw new FeedError(
      "Feed is over 4 GB; CJ requires files that large to be zipped, which this script does not do.",
    );
  }

  let outPath: string | null = null;
  if (options.outPath) {
    mkdirSync(dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, buffer);
    outPath = options.outPath;
    log(`Wrote ${outPath}`);
  }

  let deliveredTo: string | null = null;
  if (dryRun) {
    log("Dry run — not delivering to CJ");
  } else if (config.delivery === "hosted") {
    // The file IS the delivery: a static host publishes it and CJ fetches it.
    if (!outPath) {
      throw new FeedError(
        'delivery is "hosted" but no output path was given. Pass --out-dir (the directory your host publishes).',
      );
    }
    deliveredTo = `hosted:${outPath}`;
    log("Written for hosting — CJ fetches it from your URL once per day");
  } else if (!secrets.sftp) {
    throw new FeedError(
      "No SFTP credentials configured. Set CJ_SFTP_HOST, CJ_SFTP_USERNAME and CJ_SFTP_PASSWORD, or pass --dry-run.",
    );
  } else {
    log(`Uploading to ${secrets.sftp.host} as ${config.fileName}…`);
    deliveredTo = await pushToSftp(
      { ...secrets.sftp, fileName: config.fileName },
      buffer,
    );
    log(`Delivered to ${deliveredTo}`);
  }

  log(`Done in ${Math.round((Date.now() - started) / 1000)}s`);

  return {
    productsSeen: built.productsSeen,
    rowsWritten: built.rowsWritten,
    rowsRejected: built.rowsRejected,
    rowsWarned: built.rowsWarned,
    bytes: buffer.byteLength,
    issues,
    deliveredTo,
    outPath,
  };
}
