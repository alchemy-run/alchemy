import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { KVNamespace } from "../../src/cloudflare/kv-namespace";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

describe("KV Namespace Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-kv`;

  test("create, update, and delete KV namespace", async () => {
    // Create a KV namespace
    const kvNamespace = new KVNamespace(testId, {
      title: `${BRANCH_PREFIX}-Test Namespace ${testId}`,
      values: [
        {
          key: "test-key-1",
          value: "test-value-1",
        },
        {
          key: "test-key-2",
          value: { hello: "world" },
        },
      ],
    });

    // Apply to create the KV namespace
    const output = await apply(kvNamespace);
    expect(output.id).toBeTruthy();
    expect(output.title).toEqual(`${BRANCH_PREFIX}-Test Namespace ${testId}`);

    // Verify KV values were set by reading them back
    await verifyKVValue(output.id, "test-key-1", "test-value-1");
    const key2Value = await getKVValue(output.id, "test-key-2");
    expect(JSON.parse(key2Value)).toEqual({ hello: "world" });

    // Update the KV namespace with new values
    const updatedKVNamespace = new KVNamespace(testId, {
      title: `${BRANCH_PREFIX}-Test Namespace ${testId}`,
      values: [
        {
          key: "test-key-1",
          value: "updated-value-1",
        },
        {
          key: "test-key-3",
          value: "new-value-3",
        },
      ],
    });

    const updateOutput = await apply(updatedKVNamespace);
    expect(updateOutput.id).toEqual(output.id);

    // for some reason 1s was not enough ... eventual consistency?
    // TODO(sam): can we read strongly consistent?
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify updated values
    await verifyKVValue(output.id, "test-key-1", "updated-value-1");
    await verifyKVValue(output.id, "test-key-3", "new-value-3");

    // Delete the KV namespace
    await destroy(kvNamespace);

    // Verify namespace was deleted
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/storage/kv/namespaces/${output.id}`,
    );

    // Should be a 404 if properly deleted
    expect(response.status).toEqual(404);
  });

  async function getKVValue(namespaceId: string, key: string): Promise<string> {
    const api = await createCloudflareApi();
    const response = await api.get(
      `/accounts/${api.accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
    );

    expect(response.ok).toBe(true);
    return await response.text();
  }

  async function verifyKVValue(
    namespaceId: string,
    key: string,
    expectedValue: string,
  ): Promise<void> {
    const value = await getKVValue(namespaceId, key);
    expect(value).toEqual(expectedValue);
  }
});
