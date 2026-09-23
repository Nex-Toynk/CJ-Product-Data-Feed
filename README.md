# cj-feed

Builds a **CJ Affiliate product feed** from a Shopify catalogue and pushes it to CJ's SFTP.
One scheduled script — no app to install, no server, no database.

Runs as a GitHub Action by default; it's a plain CLI, so any cron works.

---

## How it works

1. Gets an access token via the client credentials grant, and checks the released app version
   actually granted the scopes the feed needs.
2. Starts a Shopify **bulk operation** exporting every product that matches your filters.
3. Polls until it finishes, then streams the JSONL result.
4. Maps it to CJ's **Shopping (Google format)** spec, validates every row.
5. Uploads to CJ's SFTP under a temp name and renames, so CJ never reads a half-written file.

Two delivery routes, set by `delivery` in the config:

- **`"sftp"`** — push to CJ's SFTP. Processed within minutes, nothing public. Needs CJ's SFTP
  to accept connections from wherever the job runs; some accounts require source-IP
  allowlisting.
- **`"hosted"`** — write the file for a static host to publish, and CJ fetches it with its
  "Client HTTP/S (Fetch)" method. Once per day, at a time CJ chooses, from a URL that must be
  publicly reachable with a CA-signed certificate. Nothing has to be allowlisted.

## Setup

### 1. Shopify app credentials

Apps created in the Shopify admin ("Develop apps") **can no longer be created** — that path is
deprecated for new apps. Instead this uses the **client credentials grant**, which is the
least-setup option for an app that only ever touches stores in its own Shopify organization:
the app swaps its own client ID and secret for a token, with no redirect flow and no install
screen to build.

In the **Dev Dashboard** (`dev.shopify.com/dashboard`):

1. Create an app, or use an existing one.
2. On the app **version**, select scopes **`read_products`** and **`read_inventory`**, then
   **Release** the version. Scopes come from the released version — the token request never
   asks for them.
3. **Install** the app on the store.
4. **Settings → Client credentials** → copy the **Client ID** and **Client secret**.

The app and the store must be under the **same organization** in the Dev Dashboard, or the
token request fails with `shop_not_permitted`. Owning a store is not the same as it being in
the org — check it appears in the dashboard's store list.

Tokens from this grant last 24 hours. The script fetches one per run and refreshes mid-run if
needed, so there is nothing to rotate by hand.

If you happen to maintain a legacy admin-created app that already has a `shpat_` token, set
`SHOPIFY_ADMIN_TOKEN` and it will be used instead.

### 2. Config

```bash
npm install
cp feed.config.example.json feed.config.json
cp .env.example .env     # read automatically; CI uses GitHub Secrets instead
```

`.env` is read on startup when present (`--env-file` points elsewhere). Real environment
variables always win over it, so a stale local file can never override a CI secret. `.env` is
gitignored.

`feed.config.json` is committed on purpose — a mapping change becomes a reviewable diff
instead of a setting someone quietly changed in a UI. Secrets stay in env.

### 3. Try it without touching CJ

```bash
npm run feed:dry -- --out-dir out
```

That builds the real feed from your live catalogue and writes it to `out/`, delivering
nothing. Set `maxRows` in the config to a few hundred for the first pass.

### 4. Register the feed in CJ

**Campaigns → Ad Assets → Product Feeds → Register Feed.**

| CJ field | Value |
|---|---|
| Format | Shopping (Google format) |
| Data Format | whatever `format` is set to |
| Delivery Method | CJ SFTP |
| File Name | must equal `fileName` exactly — case sensitive |
| Mode | **test** to start |
| Currency / Target Country | must match the config |

CJ emails the SFTP credentials once the feed is registered. In test mode CJ emails an import
report without publishing anything — read it, fix what it flags, then switch to live.

### 5a. Publishing for CJ to fetch (`delivery: "hosted"`)

The included workflow builds the feed and publishes it to **GitHub Pages**. Turn Pages on once:
repo **Settings → Pages → Source: GitHub Actions**. After the first successful run your feed is at

```
https://<org>.github.io/<repo>/<hostedPathPrefix>/<fileName>
```

Put that URL into CJ's feed settings with Delivery Method **Client HTTP/S (Fetch)**.

The feed sits behind a random path segment so it is not at a guessable URL. **That segment never
goes in the repo** — it comes from the `CJ_HOSTED_PATH_PREFIX` secret, because a value committed
here is readable by anyone with access to the repository, including in git history. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))"
```

Add it as a repository secret named `CJ_HOSTED_PATH_PREFIX`. A `hosted` run refuses to start
without it rather than publishing the catalogue at the site root.

**Understand what this exposes.** CJ's fetch sends no credentials, so the URL cannot be
protected. Anyone with the link can download your whole catalogue — SKUs, prices and stock
status in one file. That is the same data your storefront serves, but far easier to take in
bulk. The workflow adds a `robots.txt` disallowing crawlers and puts nothing at the site root
that hints at the path, which is obscurity, not security. If that trade is not acceptable, use
SFTP.

**GitHub Pages limits worth knowing.** On the Free plan, Pages only works from a **public
repo**; Pro, Team and Enterprise can publish Pages from a private one. Either way the published
site is publicly readable — which is required, since CJ cannot authenticate. Pages has a 1 GB
site limit and a soft 100 GB/month bandwidth cap; a 52 MB feed fetched once a day is nowhere
near either.

**If the repository is public**, check before making it so: `CJ_HOSTED_PATH_PREFIX` must be a
secret and not in any commit, and `git log --all --full-history -- .env` must come back empty.
Rotate the prefix if an earlier commit ever contained one — history stays readable after the
repo goes public.

If the repo must stay private on a Free plan, publish the `site/` directory somewhere else
instead — Vercel, Netlify, S3 + CloudFront, Cloudflare R2 — and point CJ at that URL. The
script's job ends at writing the file; only the publish step changes.

### 5b. Schedule it

Add these repository secrets: `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`CJ_SFTP_HOST`, `CJ_SFTP_USERNAME`, `CJ_SFTP_PASSWORD`. The workflow in `.github/workflows/cj-feed.yml` runs
daily at 05:30 UTC and can be triggered by hand, with a dry-run checkbox.

Each run uploads the generated feed and a JSON list of every row problem as build artifacts,
and writes a summary table to the run page.

## Configuration

| Key | Notes |
|---|---|
| `fileName` | Must match CJ exactly, forever. Dates and placeholders are rejected at load. |
| `delivery` | `"sftp"` or `"hosted"` — see above. |
| `hostedPathPrefix` | Random URL path segment used when hosting. Set it via the `CJ_HOSTED_PATH_PREFIX` environment variable, not in this file. |
| `format` | `CSV`, `TSV`, `PIPE` or `XML`. The extension must agree. |
| `quotedValues` | Must match the Quoted Values setting in CJ's feed registration. |
| `currency`, `targetCountry`, `condition` | Applied to every row. |
| `linkUtm` | Query string appended to every product link. |
| `flatShippingPrice` | `"0"` for free. Shipping is a required CJ column. |
| `taxRate` | A percentage like `"8.75"`, or `null` to omit the column. |
| `includeDraft`, `requireOnlineStore`, `includeOutOfStock` | Which products qualify. |
| `excludeTags`, `includeTags`, `excludeVendors`, `minPrice` | Further filtering. **Confirm what a tag actually means before excluding on it** — see below. |
| `maxRows` | Cap the feed. For testing. |
| `minRows`, `maxRejectRate` | Guard rails — see below. |
| `mappingOverrides`, `customLabels` | Source expressions, below. |

### Exclusions are easy to get wrong

A tag name is not a specification. `not-included` sounds like "keep this out of feeds"; in one
catalogue it turned out to mark products outside a BOGO promotion, and excluding on it removed
415 in-stock products from the feed with nothing in the output to explain the drop.

So every run now prints what each filter removed:

```
Filtered out 723 products before mapping: excluded tag ×715, gift card ×8
```

Check that line against what you expect. Before adding a tag to `excludeTags`, count it in the
Shopify admin and look at a few of the products.

### Guard rails

`minRows` and `maxRejectRate` abort the run instead of delivering. A mapping mistake or a
partial Shopify response would otherwise replace a good feed with a gutted one, and CJ would
happily import it — dropping most of the catalogue from every publisher's site until someone
noticed. Set `minRows` comfortably below the real count and leave `maxRejectRate` low.

### Source expressions

Used in `mappingOverrides` (keyed by CJ column) and `customLabels`:

| Expression | Result |
|---|---|
| `LITERAL:unisex` | a fixed value |
| `METAFIELD:gpc` | a product metafield in `metafieldNamespace` |
| `TAG_PREFIX:season-` | first tag with that prefix, prefix stripped |
| `HAS_TAG:clearance` | `yes` when the tag is present |
| `FIELD:vendor` | vendor, productType, handle, category, title, sku, barcode, price, compareAtPrice, inventoryQuantity, variantTitle |

### google_product_category

CJ doesn't require it, but without it you get no product reporting in CJ Insights. Three ways
to fill it, cheapest first:

1. **From Shopify's product taxonomy** — set
   `"google_product_category": "FIELD:category"` in `mappingOverrides`. Shopify's Standard
   Product Taxonomy paths read like Google's ("Toys & Games > Toys > Dolls, Playsets & Toy
   Figures > Action & Toy Figures > Action Figures") and match in most branches, but the two
   are not guaranteed identical. CJ drops a value it can't match **with a warning, without
   rejecting the row**, so this is strictly better than leaving it blank and costs nothing.
   This is what the example config does.
2. **A metafield** — populate one per product and point `metafieldNamespace` +
   `METAFIELD:<key>` at it. Exact, and a lot of content work.
3. **Leave it blank** — the feed imports fine; you just lose Insights reporting.

### Default mapping

| CJ field | Source |
|---|---|
| `id`, `mpn` | variant SKU (falls back to `handle-variantId`, sanitised to CJ's charset) |
| `title` | product title, plus variant title when there is more than one variant |
| `description` | `descriptionHtml` flattened to one line of plain text |
| `link` | `onlineStoreUrl` + `?variant=` + `linkUtm` |
| `image_link` / `additional_image_link` | featured image, then up to 10 more |
| `availability` | `availableForSale`, with `inventoryPolicy: CONTINUE` counted as in stock |
| `price` / `sale_price` | compare-at becomes `price`, current becomes `sale_price` |
| `brand` | vendor |
| `gtin` | barcode, validated to 8/10–14 digits or dropped |
| `identifier_exists` | `no` when there is no brand+GTIN and no brand+MPN |
| `item_group_id` | product ID, on multi-variant products only |
| `color` / `size` | the variant options named in the config |
| `google_product_category` | a metafield in `metafieldNamespace` named `gpc` or `google_product_category`, or override it — see below |

## CJ rules this encodes

- **The file name must never change** — no timestamps. CJ matches submissions by name, case
  sensitively. Rejected at config load.
- **SFTP uploads must land in the root directory.** A subdirectory is silently not processed.
- **Duplicate `id` values remove every product sharing that id.** Duplicate SKUs are rejected
  before the file is written.
- **A comma in a price is read as a decimal point** (`1,500` imports as `1.50`). Prices are
  always plain two-decimal values.
- Rows without a description, a valid link or a price are rejected by CJ, so they are dropped
  here with a reason you can read rather than silently lost.
- Files over 4 GB must be zipped; this script refuses rather than submitting something CJ
  will reject.

## Commands

```bash
npm run feed                 # build and deliver
npm run feed:dry             # build only
npm run feed -- --out-dir out --issues-out out/issues.json
npm run sample               # print a feed from fixtures, no store needed
npm test
npm run typecheck
```

Exit codes: `0` success, `1` the feed was not delivered, `2` a configuration problem.

## Layout

```
src/
  cj/          feed spec, Shopify to CJ mapping, CSV/XML serialisers, validator
  shopify/     token provider, admin client, bulk operations, JSONL parser
  deliver/     SFTP push
  config.ts    feed.config.json + env loading and validation
  run.ts       the pipeline
  cli.ts       argument parsing, exit codes, CI summary
```

`src/cj/` is independent of how the script is invoked. If this ever needs a UI or a second
store, that's the part that carries over.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `shop_not_permitted` | The app and the store are in different Shopify organizations, or `SHOPIFY_SHOP` is wrong. Client credentials cannot reach a store outside the app's org. |
| `missing read_products and read_inventory` | The scopes aren't on the **released** app version, or the change hasn't been approved on the store. |
| Shopify rejected the request (403) | The app isn't installed on the store. |
| `kex_exchange_identification: Connection closed` on upload | CJ's SFTP is refusing your source IP before authentication. Ask CJ to allowlist it, or switch `delivery` to `"hosted"`. |
| `onlineStoreUrl` null, every row rejected on `link` | Products aren't published to the Online Store sales channel. |

## Limits

- One bulk query per app per shop at a time. A stale operation from a crashed run is cancelled
  automatically; the workflow's concurrency group stops two runs overlapping.
- The run waits up to 45 minutes for Shopify, then cancels and fails.
- CJ's Travel & Experiences and Finance specs are not implemented — Shopping only.
