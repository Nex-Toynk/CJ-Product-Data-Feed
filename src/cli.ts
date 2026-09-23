#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfigFile, loadEnvFile, loadSecrets } from "./config";
import { createAdminClient } from "./shopify/admin";
import { createTokenProvider, missingScopes, staticTokenProvider } from "./shopify/token";
import { FeedError, runFeed } from "./run";
import { ShopifyAuthError } from "./shopify/token";

interface Args {
  dryRun: boolean;
  config: string;
  envFile: string;
  out?: string;
  outDir?: string;
  issuesOut?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, config: "feed.config.json", envFile: ".env", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run": args.dryRun = true; break;
      case "--help": case "-h": args.help = true; break;
      case "--config": args.config = argv[++i] ?? args.config; break;
      case "--env-file": args.envFile = argv[++i] ?? args.envFile; break;
      case "--out": args.out = argv[++i]; break;
      case "--out-dir": args.outDir = argv[++i]; break;
      case "--issues-out": args.issuesOut = argv[++i]; break;
      default:
        if (arg.startsWith("--")) throw new ConfigError(`Unknown option ${arg}`);
    }
  }
  return args;
}

const USAGE = `
cj-feed — build a CJ Affiliate product feed from Shopify and deliver it

  cj-feed [options]

  --dry-run            build the feed but do not upload it to CJ
  --config <path>      config file (default: feed.config.json)
  --env-file <path>    env file to load, if present (default: .env).
                       Real environment variables always win.
  --out <path>         also write the feed to this exact path
  --out-dir <dir>      also write the feed into this directory, under its
                       configured file name
  --issues-out <path>  write the full list of row problems here as JSON
  -h, --help           show this

Environment:
  SHOPIFY_SHOP           your-store.myshopify.com
  SHOPIFY_CLIENT_ID      Client ID of your app in the Dev Dashboard
  SHOPIFY_CLIENT_SECRET  Client secret of that app
  SHOPIFY_ADMIN_TOKEN    optional; a pasted token for a legacy
                         admin-created app, used instead of the above
  SHOPIFY_API_VERSION    optional, defaults to 2026-07
  CJ_SFTP_HOST           CJ's SFTP host (omit to require --dry-run)
  CJ_SFTP_PORT           optional, defaults to 22
  CJ_SFTP_USERNAME       CJ SFTP username
  CJ_SFTP_PASSWORD       CJ SFTP password
  CJ_SFTP_DIR            optional, defaults to / (CJ only reads the root)
`.trim();

function writeJobSummary(lines: string[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, lines.join("\n") + "\n");
  } catch {
    // A summary is a nicety; never fail the run over it.
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  const log = (message: string) => process.stdout.write(`${message}\n`);

  loadEnvFile(args.envFile);

  const config = loadConfigFile(args.config);
  const secrets = loadSecrets();

  if (!args.dryRun && config.delivery === "sftp" && !secrets.sftp) {
    throw new ConfigError(
      "No CJ SFTP credentials found and --dry-run was not passed. Nothing would be delivered. " +
        'Set the CJ_SFTP_* variables, or switch "delivery" to "hosted" in the config.',
    );
  }

  const tokens =
    secrets.auth.kind === "static_token"
      ? staticTokenProvider(secrets.auth.token)
      : createTokenProvider({
          shop: secrets.shop,
          clientId: secrets.auth.clientId,
          clientSecret: secrets.auth.clientSecret,
        });

  if (secrets.auth.kind === "client_credentials") {
    // Fail here, with a clear reason, rather than deep inside the export.
    await tokens.get();
    const missing = missingScopes(tokens.grantedScopes());
    if (missing.length) {
      throw new ConfigError(
        `The app version released on ${secrets.shop} is missing ${missing.join(" and ")}. ` +
          "Add the scope on the app version in the Dev Dashboard, release it, and approve the change on the store.",
      );
    }
  }

  const admin = createAdminClient({
    shop: secrets.shop,
    apiVersion: secrets.apiVersion,
    tokens,
  });

  // Hosted delivery tucks the file behind an unguessable path segment, so the
  // published URL is not something a crawler finds by guessing the file name.
  const relativePath =
    config.delivery === "hosted" && config.hostedPathPrefix
      ? join(config.hostedPathPrefix, config.fileName)
      : config.fileName;
  const outPath = args.out ?? (args.outDir ? join(args.outDir, relativePath) : undefined);

  const result = await runFeed({ config, secrets, admin, dryRun: args.dryRun, outPath, log });

  if (args.issuesOut) {
    writeFileSync(args.issuesOut, JSON.stringify(result.issues, null, 2));
    log(`Wrote ${result.issues.length} row problems to ${args.issuesOut}`);
  }

  const dropped = result.issues.filter((i) => i.level === "reject" && i.stage === "build");
  writeJobSummary([
    `### CJ feed ${args.dryRun ? "(dry run)" : ""}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Products | ${result.productsSeen} |`,
    `| Rows written | ${result.rowsWritten} |`,
    `| Dropped before writing | ${result.rowsRejected} |`,
    `| Written with a field omitted | ${result.rowsWarned} |`,
    `| Size | ${(result.bytes / 1024 / 1024).toFixed(2)} MB |`,
    `| Delivered to | ${result.deliveredTo ?? "not delivered"} |`,
    "",
    ...(dropped.length
      ? [
          "<details><summary>Rows dropped before writing</summary>", "",
          "| id | field | problem |", "|---|---|---|",
          ...dropped.slice(0, 25).map((i) => `| \`${i.id}\` | ${i.field} | ${i.message} |`),
          "", "</details>",
        ]
      : []),
  ]);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof ShopifyAuthError) {
      process.stderr.write(`Shopify authentication failed: ${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration problem: ${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof FeedError) {
      process.stderr.write(`Feed not delivered: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
