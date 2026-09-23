import { describe, expect, it, vi } from "vitest";
import { createAdminClient } from "../src/shopify/admin";
import type { TokenProvider } from "../src/shopify/token";

function tokenProvider(tokens: string[]): TokenProvider {
  let i = 0;
  let current: string | null = null;
  return {
    async get() {
      current ??= tokens[Math.min(i, tokens.length - 1)];
      return current;
    },
    invalidate() {
      current = null;
      i += 1;
    },
    grantedScopes: () => null,
  };
}

const ok = () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });

describe("createAdminClient", () => {
  it("sends the token from the provider on the right endpoint", async () => {
    const seen: Array<{ url: string; token: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, token: (init.headers as Record<string, string>)["X-Shopify-Access-Token"] });
      return ok();
    }) as unknown as typeof fetch;

    const admin = createAdminClient({
      shop: "toynk.myshopify.com",
      apiVersion: "2026-07",
      tokens: tokenProvider(["tok-1"]),
      fetchImpl,
    });

    await admin.graphql("query { shop { name } }");
    expect(seen[0].url).toBe("https://toynk.myshopify.com/admin/api/2026-07/graphql.json");
    expect(seen[0].token).toBe("tok-1");
  });

  it("retries a 401 once with a fresh token", async () => {
    const used: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      used.push((init.headers as Record<string, string>)["X-Shopify-Access-Token"]);
      call += 1;
      return call === 1 ? new Response("", { status: 401 }) : ok();
    }) as unknown as typeof fetch;

    const admin = createAdminClient({
      shop: "toynk.myshopify.com",
      apiVersion: "2026-07",
      tokens: tokenProvider(["stale", "fresh"]),
      fetchImpl,
    });

    const response = await admin.graphql("query { shop { name } }");
    expect(response.status).toBe(200);
    expect(used).toEqual(["stale", "fresh"]);
  });

  it("gives a scope-aware message on a persistent 401", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const admin = createAdminClient({
      shop: "toynk.myshopify.com",
      apiVersion: "2026-07",
      tokens: tokenProvider(["a", "b"]),
      fetchImpl,
      maxRetries: 2,
    });

    await expect(admin.graphql("query { shop { name } }")).rejects.toThrow(
      /read_products and read_inventory are selected/,
    );
  });

  it("retries a 429 and succeeds", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call < 3 ? new Response("", { status: 429 }) : ok();
    }) as unknown as typeof fetch;

    const admin = createAdminClient({
      shop: "toynk.myshopify.com",
      apiVersion: "2026-07",
      tokens: tokenProvider(["tok"]),
      fetchImpl,
    });

    const promise = admin.graphql("query { shop { name } }");
    await vi.runAllTimersAsync();
    const response = await promise;
    vi.useRealTimers();

    expect(response.status).toBe(200);
    expect(call).toBe(3);
  });

  it("gives up with a clear message after exhausting retries", async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const admin = createAdminClient({
      shop: "toynk.myshopify.com",
      apiVersion: "2026-07",
      tokens: tokenProvider(["tok"]),
      fetchImpl,
      maxRetries: 2,
    });

    const promise = admin.graphql("query { shop { name } }").catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const error = await promise;
    vi.useRealTimers();

    expect((error as Error).message).toMatch(/failed after 3 attempts/);
  });
});
