import type { AdminClient } from "./bulk";
import type { TokenProvider } from "./token";

export interface AdminClientOptions {
  shop: string;
  apiVersion: string;
  tokens: TokenProvider;
  /** Retries on 429 and 5xx. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Admin API client.
 *
 * The token comes from a provider rather than a constant, because a client
 * credentials token lasts 24 hours. A run that outlives its token refreshes
 * mid-flight; a 401 also triggers one retry with a fresh token, in case the
 * token was retired early.
 */
export function createAdminClient(options: AdminClientOptions): AdminClient {
  const endpoint = `https://${options.shop}/admin/api/${options.apiVersion}/graphql.json`;
  const maxRetries = options.maxRetries ?? 4;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async graphql(query, init) {
      let lastError: unknown;
      let retriedAuth = false;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0) {
          // Shopify's GraphQL cost limiter refills over a second or two.
          await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
        }

        const token = await options.tokens.get();

        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": token,
              Accept: "application/json",
            },
            body: JSON.stringify({ query, variables: init?.variables ?? {} }),
          });
        } catch (error) {
          lastError = error;
          continue;
        }

        if (response.status === 401 && !retriedAuth) {
          // The token may have been retired; take one fresh one before giving up.
          retriedAuth = true;
          options.tokens.invalidate();
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `Shopify rejected the request (${response.status}). Check that the app is installed on ${options.shop} ` +
              "and that read_products and read_inventory are selected on the released app version.",
          );
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Shopify responded ${response.status} ${response.statusText}`);
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Shopify responded ${response.status} ${response.statusText}: ${await response.text()}`,
          );
        }
        return response;
      }

      throw new Error(
        `Shopify request failed after ${maxRetries + 1} attempts: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
