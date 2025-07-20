import { expect } from "vitest";
import type { CloudflareApi } from "../../src/cloudflare/api.ts";

/**
 * Helper function to check if a worker exists and assert it doesn't
 */
export async function assertWorkerDoesNotExist(
  api: CloudflareApi,
  workerName: string,
) {
  const response = await api.get(
    `/accounts/${api.accountId}/workers/scripts/${workerName}`,
  );
  expect(response.status).toEqual(404);
}
