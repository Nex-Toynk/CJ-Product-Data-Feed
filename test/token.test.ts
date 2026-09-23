import { describe, expect, it, vi } from "vitest";
import {
  createTokenProvider,
  missingScopes,
  ShopifyAuthError,
  staticTokenProvider,
} from "../src/shopify/token";

const SHOP = "toynk.myshopify.com";

function tokenResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function provider(fetchImpl: typeof fetch, refreshMarginMs?: number) {
  return createTokenProvider({
    shop: SHOP,
    clientId: "cid",
    clientSecret: "csecret",
    fetchImpl,
    refreshMarginMs,
  });
}

describe("createTokenProvider", () => {
  it("exchanges client credentials at the right endpoint with the right body", async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: String(init.body),
        headers: init.headers as Record<string, string>,
      });
      return tokenResponse({ access_token: "tok-1", scope: "read_products,read_inventory", expires_in: 86399 });
    }) as unknown as typeof fetch;

    const tokens = provider(fetchImpl);
    expect(await tokens.get()).toBe("tok-1");

    expect(calls[0].url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(calls[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    // Scopes come from the released app version, never from this request.
    expect(body.get("scope")).toBeNull();

    expect(tokens.grantedScopes()).toEqual(["read_products", "read_inventory"]);
  });

  it("caches the token instead of fetching per call", async () => {
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: "tok-1", scope: "read_products", expires_in: 86399 }),
    ) as unknown as typeof fetch;

    const tokens = provider(fetchImpl);
    await tokens.get();
    await tokens.get();
    await tokens.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the token is inside the refresh margin", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: `tok-${++n}`, scope: "read_products", expires_in: 60 }),
    ) as unknown as typeof fetch;

    // A 60s token with a 5-minute margin is always due for refresh.
    const tokens = provider(fetchImpl, 5 * 60_000);
    expect(await tokens.get()).toBe("tok-1");
    expect(await tokens.get()).toBe("tok-2");
  });

  it("collapses concurrent callers onto one request", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return tokenResponse({ access_token: "tok-1", scope: "read_products", expires_in: 86399 });
    }) as unknown as typeof fetch;

    const tokens = provider(fetchImpl);
    const results = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(results).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches after invalidate()", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: `tok-${++n}`, scope: "read_products", expires_in: 86399 }),
    ) as unknown as typeof fetch;

    const tokens = provider(fetchImpl);
    expect(await tokens.get()).toBe("tok-1");
    tokens.invalidate();
    expect(await tokens.get()).toBe("tok-2");
  });

  it("explains shop_not_permitted rather than passing it through", async () => {
    const fetchImpl = (async () =>
      tokenResponse(
        { error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." },
        400,
      )) as unknown as typeof fetch;

    await expect(provider(fetchImpl).get()).rejects.toThrow(/same\s+Shopify organization/);
  });

  it("surfaces other token errors with the status", async () => {
    const fetchImpl = (async () =>
      tokenResponse({ error: "invalid_client", error_description: "Bad client secret" }, 401)) as unknown as typeof fetch;

    await expect(provider(fetchImpl).get()).rejects.toThrow(ShopifyAuthError);
    await expect(provider(fetchImpl).get()).rejects.toThrow(/Bad client secret/);
  });

  it("does not choke on an HTML error page", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch;

    await expect(provider(fetchImpl).get()).rejects.toThrow(/non-JSON body/);
  });
});

describe("staticTokenProvider", () => {
  it("returns the token it was given and never expires", async () => {
    const tokens = staticTokenProvider("shpat_legacy");
    expect(await tokens.get()).toBe("shpat_legacy");
    tokens.invalidate();
    expect(await tokens.get()).toBe("shpat_legacy");
    expect(tokens.grantedScopes()).toBeNull();
  });
});

describe("missingScopes", () => {
  it("names the scopes the feed needs but did not get", () => {
    expect(missingScopes(["read_products", "read_inventory"])).toEqual([]);
    expect(missingScopes(["read_products"])).toEqual(["read_inventory"]);
    expect(missingScopes(["read_orders"])).toEqual(["read_products", "read_inventory"]);
  });

  it("stays quiet when scopes are unknown", () => {
    // A legacy pasted token reports nothing; that is not a missing scope.
    expect(missingScopes(null)).toEqual([]);
    expect(missingScopes([])).toEqual([]);
  });
});
