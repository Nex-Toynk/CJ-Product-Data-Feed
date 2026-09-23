/**
 * Client credentials grant.
 *
 * Apps created directly in the Shopify admin ("Develop apps") can no longer be
 * created, so there is no pre-generated shpat_ token to paste. For an app that
 * only ever acts on stores in its own Shopify organization, the client
 * credentials grant is the least-setup replacement: the app exchanges its own
 * client ID and secret for a token, with no redirect flow and no merchant
 * install screen.
 *
 * Two things differ from the old token:
 *   - it expires after 24 hours, so it has to be fetched and refreshed
 *   - the app and the store must be in the same organization in the Dev
 *     Dashboard, or Shopify answers shop_not_permitted
 */

export interface TokenProviderOptions {
  shop: string;
  clientId: string;
  clientSecret: string;
  /** Refresh this long before expiry. Default 5 minutes. */
  refreshMarginMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TokenProvider {
  /** A valid token, fetched or from cache. */
  get(): Promise<string>;
  /** Drop the cached token, so the next get() fetches a fresh one. */
  invalidate(): void;
  /** Scopes Shopify reported for the current token, once one has been fetched. */
  grantedScopes(): string[] | null;
}

interface TokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class ShopifyAuthError extends Error {}

export function createTokenProvider(options: TokenProviderOptions): TokenProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const margin = options.refreshMarginMs ?? 5 * 60_000;
  const url = `https://${options.shop}/admin/oauth/access_token`;

  let token: string | null = null;
  let expiresAt = 0;
  let scopes: string[] | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });

    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const text = await response.text();
    let payload: TokenResponse;
    try {
      payload = JSON.parse(text) as TokenResponse;
    } catch {
      throw new ShopifyAuthError(
        `Token endpoint returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
      );
    }

    if (payload.error === "shop_not_permitted" || /shop_not_permitted/.test(text)) {
      throw new ShopifyAuthError(
        "shop_not_permitted: the client credentials grant only works when the app and the store are in the same " +
          "Shopify organization. Check that the store is listed under the same org as the app in the Dev Dashboard, " +
          `and that SHOPIFY_SHOP ("${options.shop}") is exactly right.`,
      );
    }
    if (!response.ok || !payload.access_token) {
      throw new ShopifyAuthError(
        `Could not get an access token (${response.status}): ${
          payload.error_description ?? payload.error ?? text.slice(0, 200)
        }`,
      );
    }

    token = payload.access_token;
    // Shopify returns 86399; treat a missing value as one hour to be safe.
    expiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    scopes = payload.scope ? payload.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return token;
  }

  return {
    async get() {
      if (token && Date.now() < expiresAt - margin) return token;
      // Collapse concurrent callers onto one request.
      inFlight ??= fetchToken().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate() {
      token = null;
      expiresAt = 0;
    },
    grantedScopes() {
      return scopes;
    },
  };
}

/** A provider wrapping a token you already hold, for a legacy admin-created app. */
export function staticTokenProvider(token: string): TokenProvider {
  return {
    async get() {
      return token;
    },
    invalidate() {},
    grantedScopes() {
      return null;
    },
  };
}

/** Warn about scopes the feed needs that Shopify did not grant. */
export const REQUIRED_SCOPES = ["read_products", "read_inventory"] as const;

export function missingScopes(granted: string[] | null): string[] {
  if (!granted || granted.length === 0) return [];
  return REQUIRED_SCOPES.filter((s) => !granted.includes(s));
}
