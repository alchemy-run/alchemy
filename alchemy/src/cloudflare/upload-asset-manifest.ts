import fs from "node:fs/promises";
import type { CloudflareApi } from "./api";
import type { AssetManifest } from "./asset-manifest";

// Maximum number of concurrent uploads
const MAX_CONCURRENT = 100; // Adjust based on API limits and performance testing

// Define types for our queue operations
type AssetItem = AssetManifest[number];
type UploadResult = {
  item: AssetItem;
  success: boolean;
  status?: number;
  error?: unknown;
};

export async function uploadAssetManifest(
  api: CloudflareApi,
  namespaceId: string,
  manifest: AssetManifest,
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];

  // Process in batches with controlled concurrency
  let index = 0;
  const activePromises = new Set<Promise<void>>();

  while (index < manifest.length || activePromises.size > 0) {
    // Fill up to MAX_CONCURRENT active uploads
    while (activePromises.size < MAX_CONCURRENT && index < manifest.length) {
      const item = manifest[index++];
      const promise = uploadItem(item).then((result) => {
        results.push(result);
        activePromises.delete(promise);
      });
      activePromises.add(promise);
    }

    // Wait for at least one promise to complete if we have any active
    if (activePromises.size > 0) {
      await Promise.race(activePromises);
    }
  }

  return results;

  async function uploadItem(item: AssetItem): Promise<UploadResult> {
    const content = await fs.readFile(item.source);

    // Create metadata object
    const metadata = {
      key: item.key,
      hash: item.hash,
      contentType: item.contentType,
      cacheControl: item.cacheControl,
    };

    // Create FormData for multipart upload
    const formData = new FormData();
    formData.append("metadata", JSON.stringify(metadata));

    // Add file content as 'value'
    const blob = new Blob([content]);
    formData.append("value", blob);

    try {
      const response = await api.put(
        `/accounts/${api.accountId}/storage/kv/namespaces/${namespaceId}/values/${item.key}`,
        formData,
      );

      const result = { item, success: response.ok, status: response.status };
      if (!result.success) {
        console.warn(`Error uploading asset ${item.key}: ${result.status}`);
      }
      return result;
    } catch (error) {
      const result = { item, success: false, error };
      console.warn(`Error uploading asset ${item.key}: ${error}`);
      return result;
    }
  }
}
