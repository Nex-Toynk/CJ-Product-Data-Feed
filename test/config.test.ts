import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfigFile, loadEnvFile, loadSecrets } from "../src/config";

function configFile(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "cjfeed-"));
  const path = join(dir, "feed.config.json");
  writeFileSync(path, JSON.stringify({ fileName: "feed.csv", format: "CSV", ...overrides }));
  return path;
}

describe("hostedPathPrefix", () => {
  it("takes the prefix from the environment, so a public repo never carries it", () => {
    const path = configFile({ delivery: "hosted", hostedPathPrefix: "" });
    const c = loadConfigFile(path, { CJ_HOSTED_PATH_PREFIX: "s3cretSlug" });
    expect(c.hostedPathPrefix).toBe("s3cretSlug");
  });

  it("lets the environment override a value left in the file", () => {
    const path = configFile({ delivery: "hosted", hostedPathPrefix: "in-the-repo" });
    expect(loadConfigFile(path, { CJ_HOSTED_PATH_PREFIX: "from-env" }).hostedPathPrefix).toBe(
      "from-env",
    );
  });

  it("refuses hosted delivery with no prefix at all", () => {
    // Publishing at the root would put the catalogue at a guessable URL.
    const path = configFile({ delivery: "hosted", hostedPathPrefix: "" });
    expect(() => loadConfigFile(path, {})).toThrow(/CJ_HOSTED_PATH_PREFIX/);
  });

  it("does not require a prefix for SFTP delivery", () => {
    const path = configFile({ delivery: "sftp", hostedPathPrefix: "" });
    expect(loadConfigFile(path, {}).hostedPathPrefix).toBe("");
  });

  it("rejects a prefix with a slash or other unsafe characters", () => {
    const path = configFile({ delivery: "hosted" });
    expect(() => loadConfigFile(path, { CJ_HOSTED_PATH_PREFIX: "a/b" })).toThrow(/URL-safe/);
    expect(() => loadConfigFile(path, { CJ_HOSTED_PATH_PREFIX: "a b" })).toThrow(/URL-safe/);
  });
});

describe("loadConfigFile", () => {
  it("fills in defaults", () => {
    const c = loadConfigFile(configFile({}));
    expect(c.currency).toBe("USD");
    expect(c.condition).toBe("new");
    expect(c.quotedValues).toBe(true);
    expect(c.requireOnlineStore).toBe(true);
    expect(c.metafieldNamespace).toBe("cj");
  });

  it("explains a missing file instead of throwing a bare ENOENT", () => {
    expect(() => loadConfigFile("/nope/feed.config.json")).toThrow(/Could not read/);
  });

  it("rejects a file name with a date, because CJ matches by an unchanging name", () => {
    expect(() => loadConfigFile(configFile({ fileName: "feed-2026-09-21.csv" }))).toThrow(
      /must not contain a date/,
    );
    expect(() => loadConfigFile(configFile({ fileName: "feed-{date}.csv" }))).toThrow(
      /must not contain a date/,
    );
  });

  it("rejects a file name whose extension contradicts the format", () => {
    expect(() => loadConfigFile(configFile({ fileName: "feed.csv", format: "XML" }))).toThrow(
      /does not match format XML/,
    );
    // .txt is acceptable for any delimited format.
    expect(loadConfigFile(configFile({ fileName: "feed.txt", format: "PIPE" })).format).toBe("PIPE");
  });

  it("rejects malformed codes and values", () => {
    expect(() => loadConfigFile(configFile({ currency: "dollars" }))).toThrow(/ISO 4217/);
    expect(() => loadConfigFile(configFile({ targetCountry: "USA" }))).toThrow(/ISO 3166/);
    expect(() => loadConfigFile(configFile({ condition: "mint" }))).toThrow(/condition must be/);
    expect(() => loadConfigFile(configFile({ taxRate: "8.75%" }))).toThrow(/taxRate/);
    expect(() => loadConfigFile(configFile({ flatShippingPrice: "$4.99" }))).toThrow(/flatShippingPrice/);
    expect(() => loadConfigFile(configFile({ format: "JSON" }))).toThrow(/format must be one of/);
    expect(() => loadConfigFile(configFile({ maxRejectRate: 2 }))).toThrow(/maxRejectRate/);
  });

  it("rejects a custom label outside custom_label_0..4", () => {
    expect(() => loadConfigFile(configFile({ customLabels: { custom_label_9: "x" } }))).toThrow(
      /custom_label_0 through custom_label_4/,
    );
  });
});

describe("loadSecrets", () => {
  const base = {
    SHOPIFY_SHOP: "toynk.myshopify.com",
    SHOPIFY_CLIENT_ID: "cid",
    SHOPIFY_CLIENT_SECRET: "csecret",
  };

  it("reads the minimum and leaves SFTP unconfigured", () => {
    const s = loadSecrets({ ...base });
    expect(s.shop).toBe("toynk.myshopify.com");
    expect(s.apiVersion).toBe("2026-07");
    expect(s.sftp).toBeNull();
    expect(s.auth).toEqual({ kind: "client_credentials", clientId: "cid", clientSecret: "csecret" });
  });

  it("strips a scheme and trailing slash from the shop domain", () => {
    expect(loadSecrets({ ...base, SHOPIFY_SHOP: "https://toynk.myshopify.com/" }).shop).toBe(
      "toynk.myshopify.com",
    );
  });

  it("rejects a shop that is not a myshopify domain", () => {
    expect(() => loadSecrets({ ...base, SHOPIFY_SHOP: "toynk.com" })).toThrow(ConfigError);
  });

  it("explains what to set when no credentials are present", () => {
    expect(() => loadSecrets({ SHOPIFY_SHOP: "toynk.myshopify.com" })).toThrow(
      /SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET/,
    );
  });

  it("requires the secret once a client ID is given", () => {
    expect(() =>
      loadSecrets({ SHOPIFY_SHOP: "toynk.myshopify.com", SHOPIFY_CLIENT_ID: "cid" }),
    ).toThrow(/SHOPIFY_CLIENT_SECRET is not set/);
  });

  it("prefers a pasted token, for a legacy admin-created app", () => {
    const s = loadSecrets({ ...base, SHOPIFY_ADMIN_TOKEN: "shpat_legacy" });
    expect(s.auth).toEqual({ kind: "static_token", token: "shpat_legacy" });
  });

  it("requires a username and password once a host is given", () => {
    expect(() => loadSecrets({ ...base, CJ_SFTP_HOST: "sftp.cj.com" })).toThrow(
      /CJ_SFTP_USERNAME is not set/,
    );

    const s = loadSecrets({
      ...base,
      CJ_SFTP_HOST: "sftp.cj.com",
      CJ_SFTP_USERNAME: "toynk",
      CJ_SFTP_PASSWORD: "secret",
    });
    expect(s.sftp).toEqual({
      host: "sftp.cj.com", port: 22, username: "toynk", password: "secret", remoteDir: "/",
    });
  });
});

describe("loadEnvFile", () => {
  function envFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cjenv-"));
    const path = join(dir, ".env");
    writeFileSync(path, contents);
    return path;
  }

  it("does nothing when the file is absent", () => {
    expect(() => loadEnvFile("/nope/.env")).not.toThrow();
  });

  it("reads values from the file into the environment", () => {
    const path = envFile("CJ_TEST_ONE=from-file\nCJ_TEST_TWO=also-from-file\n");
    delete process.env.CJ_TEST_ONE;
    delete process.env.CJ_TEST_TWO;

    loadEnvFile(path);
    expect(process.env.CJ_TEST_ONE).toBe("from-file");
    expect(process.env.CJ_TEST_TWO).toBe("also-from-file");

    delete process.env.CJ_TEST_ONE;
    delete process.env.CJ_TEST_TWO;
  });

  it("lets a real environment variable win over the file", () => {
    // This is what keeps a stale local .env from overriding CI secrets.
    const path = envFile("CJ_TEST_THREE=from-file\n");
    process.env.CJ_TEST_THREE = "from-environment";

    loadEnvFile(path);
    expect(process.env.CJ_TEST_THREE).toBe("from-environment");

    delete process.env.CJ_TEST_THREE;
  });
});
