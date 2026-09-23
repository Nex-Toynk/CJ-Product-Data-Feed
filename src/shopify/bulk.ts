import {
  BULK_BY_ID_QUERY,
  BULK_CANCEL_MUTATION,
  BULK_RUN_MUTATION,
  CURRENT_BULK_QUERY,
  buildBulkQuery,
} from "./queries";

/** Minimal shape of the admin client returned by authenticate.admin / unauthenticated.admin. */
export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface BulkOperationState {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  fileSize: string | null;
  url: string | null;
  partialDataUrl: string | null;
  completedAt: string | null;
}

async function gql<T>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  if (!payload.data) throw new Error("Shopify returned no data");
  return payload.data;
}

export async function startProductBulkExport(
  admin: AdminClient,
  opts: { includeDraft: boolean; requireOnlineStore: boolean; metafieldNamespace: string },
): Promise<{ id: string; status: string }> {
  const data = await gql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(admin, BULK_RUN_MUTATION, { query: buildBulkQuery(opts) });

  const result = data.bulkOperationRunQuery;
  if (result.userErrors.length) {
    const message = result.userErrors.map((e) => e.message).join("; ");
    // Shopify allows one running bulk query per shop per app.
    throw new Error(`Could not start bulk export: ${message}`);
  }
  if (!result.bulkOperation) throw new Error("Could not start bulk export: no operation returned");
  return result.bulkOperation;
}

export async function getBulkOperation(
  admin: AdminClient,
  id: string,
): Promise<BulkOperationState | null> {
  const data = await gql<{ node: (BulkOperationState & { type?: string }) | null }>(
    admin,
    BULK_BY_ID_QUERY,
    { id },
  );
  return data.node ?? null;
}

export async function cancelBulkOperation(admin: AdminClient, id: string): Promise<void> {
  await gql(admin, BULK_CANCEL_MUTATION, { id }).catch(() => undefined);
}

/**
 * Fetch the JSONL result. The URL is a pre-signed Google Storage link that
 * expires about a week after the operation completes, and needs no auth.
 */
export async function openBulkResult(url: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download bulk result (${response.status} ${response.statusText})`);
  }
  return response.body;
}

export async function getCurrentBulkOperation(
  admin: AdminClient,
): Promise<{ id: string; status: string; createdAt: string } | null> {
  const data = await gql<{
    currentBulkOperation: { id: string; status: string; createdAt: string } | null;
  }>(admin, CURRENT_BULK_QUERY);
  return data.currentBulkOperation;
}

const RUNNING = new Set(["CREATED", "RUNNING"]);

/**
 * Shopify allows one running bulk query per app per shop. If a previous run
 * died before its operation finished, the next run cannot start until that one
 * is out of the way.
 */
export async function clearStaleBulkOperation(
  admin: AdminClient,
  log: (message: string) => void,
): Promise<void> {
  const current = await getCurrentBulkOperation(admin).catch(() => null);
  if (!current || !RUNNING.has(current.status)) return;

  log(`Cancelling a bulk operation left running since ${current.createdAt} (${current.id})`);
  await cancelBulkOperation(admin, current.id);

  // Cancellation is not instant; give it a moment to leave the running state.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const state = await getBulkOperation(admin, current.id);
    if (!state || !RUNNING.has(state.status)) return;
  }
  throw new Error(`Bulk operation ${current.id} would not cancel; try again shortly`);
}

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onProgress?: (state: BulkOperationState) => void;
}

/** Poll until the operation leaves the running state, or time runs out. */
export async function waitForBulkOperation(
  admin: AdminClient,
  id: string,
  options: WaitOptions = {},
): Promise<BulkOperationState> {
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 45 * 60_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const state = await getBulkOperation(admin, id);
    if (!state) throw new Error(`Bulk operation ${id} no longer exists`);
    if (!RUNNING.has(state.status)) return state;

    options.onProgress?.(state);

    if (Date.now() + pollIntervalMs > deadline) {
      await cancelBulkOperation(admin, id);
      throw new Error(
        `Bulk operation ${id} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
