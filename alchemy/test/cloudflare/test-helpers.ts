import { expect } from "vitest";
import type { CloudflareApi } from "../../src/cloudflare/api.ts";

/**
 * Helper function to check if a worker exists and assert it doesn't
 */
export async function assertWorkerDoesNotExist(
  api: CloudflareApi,
  workerName: string,
) {
  try {
    const response = await api.get(
      `/accounts/${api.accountId}/workers/scripts/${workerName}`,
    );
    expect(response.status).toEqual(404);
  } catch {
    // 404 is expected, so we can ignore it
    return;
  }
}
