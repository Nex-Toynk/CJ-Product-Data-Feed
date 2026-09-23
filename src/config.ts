import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FeedOptions } from "./cj/types";

export type FeedFormat = "CSV" | "TSV" | "PIPE" | "XML";

/**
 * How the feed reaches CJ.
 *   "sftp"   — we push to CJ's SFTP. Updates within minutes.
 *   "hosted" — we write the file for a static host to publish, and CJ fetches
 *              it once per day (CJ's "Client HTTP/S (Fetch)" delivery method).
 *              CJ cannot authenticate, so the URL must be publicly reachable
 *              with a CA-signed certificate.
 */
export type Delivery = "sftp" | "hosted";

/**
 * Everything that is not a secret lives in feed.config.json, committed to the
 * repo — so a mapping change is a reviewable diff rather than a setting someone
 * changed in a UI three months ago.
 */
export interface FeedConfigFile {
  /** Must match the File Name registered in CJ exactly. Case sensitive, no timestamps. */
  fileName: string;
  delivery: Delivery;
  /**
   * Path segment placed before the file name when delivery is "hosted", so the
   * feed is not sitting at a guessable URL. CJ cannot send credentials, so this
   * is the only thing keeping the catalogue from being trivially downloadable.
   *
   * In a PUBLIC repository this must come from the CJ_HOSTED_PATH_PREFIX
   * environment variable, never from this file — a committed value is readable
   * by anyone, including in git history.
   */
  hostedPathPrefix: string;
  format: FeedFormat;
  quotedValues: boolean;
  currency: string;
  targetCountry: string;
  condition: string;
  linkUtm: string | null;
  flatShippingPrice: string | null;
  shippingCountry: string;
  taxRate: string | null;
  colorOptionName: string | null;
  sizeOptionName: string | null;
  ageGroup: string | null;
  metafieldNamespace: string;
  includeDraft: boolean;
  requireOnlineStore: boolean;
  includeOutOfStock: boolean;
  excludeTags: string[];
  includeTags: string[];
  excludeVendors: string[];
  minPrice: number | null;
  maxRows: number | null;
  mappingOverrides: Record<string, string>;
  customLabels: Record<string, string>;
  /** Abort rather than deliver if fewer rows than this survive. Catches a broken run. */
  minRows: number;
  /** Abort if more than this share of candidate rows are rejected (0–1). */
  maxRejectRate: number;
}

/**
 * How the script authenticates. Apps created in the Shopify admin can no longer
 * be created, so the client credentials grant is the normal path: the app and
 * the store sit in the same Shopify organization and the app swaps its own
 * client ID and secret for a 24-hour token. A pasted token is still supported
 * for a legacy admin-created app that already has one.
 */
export type ShopifyAuth =
  | { kind: "client_credentials"; clientId: string; clientSecret: string }
  | { kind: "static_token"; token: string };

export interface Secrets {
  shop: string;
  auth: ShopifyAuth;
  apiVersion: string;
  sftp: {
    host: string;
    port: number;
    username: string;
    password: string;
    remoteDir: string;
  } | null;
}

const DEFAULTS: FeedConfigFile = {
  fileName: "product-feed.csv",
  delivery: "sftp",
  hostedPathPrefix: "",
  format: "CSV",
  quotedValues: true,
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
  maxRejectRate: 0.1,
};

const FORMATS: FeedFormat[] = ["CSV", "TSV", "PIPE", "XML"];
const EXTENSION_BY_FORMAT: Record<FeedFormat, string[]> = {
  CSV: ["csv", "txt"],
  TSV: ["tsv", "txt"],
  PIPE: ["psv", "txt"],
  XML: ["xml"],
};

export class ConfigError extends Error {}

/**
 * Load a .env file when one is present, without a dependency — Node 20.6+ can
 * parse one itself. Variables already in the environment win, so CI secrets and
 * an inline `FOO=bar npm run ...` are never clobbered by a stale local file.
 */
export function loadEnvFile(path = ".env", env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;

  const alreadySet = { ...env };
  try {
    process.loadEnvFile(path);
  } catch (error) {
    throw new ConfigError(`Could not read ${path}: ${(error as Error).message}`);
  }
  for (const [key, value] of Object.entries(alreadySet)) {
    if (value !== undefined) env[key] = value;
  }
}

export function loadConfigFile(
  path = "feed.config.json",
  env: NodeJS.ProcessEnv = process.env,
): FeedConfigFile {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch {
    throw new ConfigError(
      `Could not read ${path}. Copy feed.config.example.json to feed.config.json and edit it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }

  const config = { ...DEFAULTS, ...(parsed as Partial<FeedConfigFile>) };

  // The path prefix is the one config value that must be able to live outside
  // the repo, so it survives the repo being public.
  const fromEnv = env.CJ_HOSTED_PATH_PREFIX?.trim();
  if (fromEnv) config.hostedPathPrefix = fromEnv;

  validate(config, path);
  return config;
}

function validate(c: FeedConfigFile, path: string): void {
  const fail = (message: string) => {
    throw new ConfigError(`${path}: ${message}`);
  };

  if (!FORMATS.includes(c.format)) fail(`format must be one of ${FORMATS.join(", ")}`);
  if (c.delivery !== "sftp" && c.delivery !== "hosted") fail('delivery must be "sftp" or "hosted"');
  if (c.hostedPathPrefix && !/^[A-Za-z0-9._~-]+$/.test(c.hostedPathPrefix)) {
    fail("hostedPathPrefix must be a single URL-safe path segment (letters, digits, . _ ~ -)");
  }
  if (c.delivery === "hosted" && !c.hostedPathPrefix) {
    // Publishing at the root would put the whole catalogue at a guessable URL.
    fail(
      'delivery is "hosted" but hostedPathPrefix is empty. Set the CJ_HOSTED_PATH_PREFIX ' +
        "environment variable to an unguessable path segment — generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(9).toString('base64url'))\"",
    );
  }

  // CJ identifies a submission by its file name, so it has to be constant.
  // Checked before the charset rule so a templated name gets the useful message.
  if (/\d{4}-?\d{2}-?\d{2}|\{|\$|%/.test(c.fileName)) {
    fail("fileName must not contain a date or a template placeholder — CJ matches files by an unchanging name");
  }
  if (!/^[\w.\-]+\.[a-z0-9]+$/i.test(c.fileName)) {
    fail("fileName must be a plain file name with an extension, e.g. product-feed.csv");
  }
  const extension = c.fileName.split(".").pop()!.toLowerCase();
  if (!EXTENSION_BY_FORMAT[c.format].includes(extension)) {
    fail(`fileName extension ".${extension}" does not match format ${c.format} (expected ${EXTENSION_BY_FORMAT[c.format].map((e) => `.${e}`).join(" or ")})`);
  }

  if (!/^[A-Z]{3}$/.test(c.currency)) fail("currency must be a 3-letter ISO 4217 code, e.g. USD");
  if (!/^[A-Z]{2}$/.test(c.targetCountry)) fail("targetCountry must be a 2-letter ISO 3166-1 code");
  if (!/^[A-Z]{2}$/.test(c.shippingCountry)) fail("shippingCountry must be a 2-letter ISO 3166-1 code");
  if (!["new", "refurbished", "used"].includes(c.condition)) {
    fail("condition must be new, refurbished or used");
  }
  if (c.taxRate !== null && !/^\d+(\.\d+)?$/.test(c.taxRate)) {
    fail('taxRate must be a plain percentage string such as "8.75", or null');
  }
  if (c.flatShippingPrice !== null && !/^\d+(\.\d+)?$/.test(c.flatShippingPrice)) {
    fail('flatShippingPrice must be a plain number string such as "0" or "4.99", or null');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(c.metafieldNamespace)) {
    fail("metafieldNamespace must be alphanumeric with - or _");
  }
  if (c.minRows < 1) fail("minRows must be at least 1");
  if (c.maxRejectRate < 0 || c.maxRejectRate > 1) fail("maxRejectRate must be between 0 and 1");

  for (const key of Object.keys(c.customLabels)) {
    if (!/^custom_label_[0-4]$/.test(key)) {
      fail(`customLabels key "${key}" must be custom_label_0 through custom_label_4`);
    }
  }
}

export function loadSecrets(env = process.env): Secrets {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`${name} is not set`);
    return value;
  };

  const shop = required("SHOPIFY_SHOP").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw new ConfigError(`SHOPIFY_SHOP must look like your-store.myshopify.com (got "${shop}")`);
  }

  // A pasted token wins when present, so a legacy admin-created app keeps working.
  const staticToken = env.SHOPIFY_ADMIN_TOKEN?.trim();
  const clientId = env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = env.SHOPIFY_CLIENT_SECRET?.trim();

  let auth: ShopifyAuth;
  if (staticToken) {
    auth = { kind: "static_token", token: staticToken };
  } else if (clientId || clientSecret) {
    auth = {
      kind: "client_credentials",
      clientId: required("SHOPIFY_CLIENT_ID"),
      clientSecret: required("SHOPIFY_CLIENT_SECRET"),
    };
  } else {
    throw new ConfigError(
      "No Shopify credentials found. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from your app in the " +
        "Dev Dashboard (Settings -> Client credentials).",
    );
  }

  const sftpHost = env.CJ_SFTP_HOST?.trim();
  const sftp = sftpHost
    ? {
        host: sftpHost,
        port: Number(env.CJ_SFTP_PORT ?? 22) || 22,
        username: required("CJ_SFTP_USERNAME"),
        password: required("CJ_SFTP_PASSWORD"),
        // CJ only processes files left in the root directory.
        remoteDir: env.CJ_SFTP_DIR?.trim() || "/",
      }
    : null;

  return {
    shop,
    auth,
    apiVersion: env.SHOPIFY_API_VERSION?.trim() || "2026-07",
    sftp,
  };
}

export function toFeedOptions(c: FeedConfigFile): FeedOptions {
  return {
    currency: c.currency,
    targetCountry: c.targetCountry,
    condition: c.condition,
    linkUtm: c.linkUtm,
    flatShippingPrice: c.flatShippingPrice,
    shippingCountry: c.shippingCountry,
    taxRate: c.taxRate,
    colorOptionName: c.colorOptionName,
    sizeOptionName: c.sizeOptionName,
    ageGroup: c.ageGroup,
    metafieldNamespace: c.metafieldNamespace,
    mappingOverrides: c.mappingOverrides,
    customLabels: c.customLabels,
    includeOutOfStock: c.includeOutOfStock,
    excludeTags: c.excludeTags,
    includeTags: c.includeTags,
    excludeVendors: c.excludeVendors,
    minPrice: c.minPrice,
    maxRows: c.maxRows,
  };
}
