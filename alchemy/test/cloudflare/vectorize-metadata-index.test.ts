import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { createCloudflareApi } from "../../src/cloudflare/api.js";
import { VectorizeIndex } from "../../src/cloudflare/vectorize-index.js";
import {
  VectorizeMetadataIndex,
  listMetadataIndexes,
} from "../../src/cloudflare/vectorize-metadata-index.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Vectorize Metadata Index Resource", async () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-meta-test`;

  // Create Cloudflare API client for direct verification
  const api = await createCloudflareApi();

  test("create and delete metadata index", async (scope) => {
    // First create a parent vectorize index
    const vectorIndex = await VectorizeIndex(`${testId}-parent`, {
      name: `${testId}-parent`,
      dimensions: 768,
      metric: "cosine",
      adopt: true,
    });

    // Then create a metadata index
    let metadataIndex: VectorizeMetadataIndex | undefined = undefined;

    try {
      metadataIndex = await VectorizeMetadataIndex(`${testId}-category`, {
        index: vectorIndex,
        propertyName: "category",
        indexType: "string",
      });

      expect(metadataIndex.id).toBeTruthy();
      expect(metadataIndex.propertyName).toEqual("category");
      expect(metadataIndex.indexType).toEqual("string");
      expect(metadataIndex.mutationId).toBeTruthy();

      // TODO(sam): re-enable this once we know what's up with the List API returning HTTP 410 gone
      // see: https://x.com/samgoodwin89/status/1912978970682831089

      // Check if metadata index exists by listing metadata indexes
      // const metadataIndexes = await listMetadataIndexes(api, vectorIndex.name);
      // const foundIndex = metadataIndexes.find(
      //   (idx) => idx.propertyName === "category"
      // );
      // expect(foundIndex).toBeTruthy();
      // expect(foundIndex?.indexType).toEqual("string");
    } finally {
      await alchemy.destroy(scope);

      // Verify metadata index was deleted
      //   if (metadataIndex) {
      //     await assertMetadataIndexDeleted(vectorIndex.name, "category");
      //   }
    }
  });

  test("throws error on update attempts", async (scope) => {
    // First create a parent vectorize index
    const vectorIndex = await VectorizeIndex(`${testId}-parent-noupdate`, {
      name: `${testId}-parent-noupdate`,
      dimensions: 768,
      metric: "cosine",
      adopt: true,
    });

    try {
      // Create a metadata index
      const metadataIndex = await VectorizeMetadataIndex(`${testId}-tag`, {
        index: vectorIndex,
        propertyName: "tag",
        indexType: "string",
      });

      expect(metadataIndex.propertyName).toEqual("tag");

      // Attempt to update the metadata index, which should throw an error
      await expect(
        VectorizeMetadataIndex(`${testId}-tag`, {
          index: vectorIndex,
          propertyName: "tag",
          indexType: "boolean", // Change the type
        }),
      ).rejects.toThrow("Updating Vectorize metadata indexes is not supported");
    } finally {
      await alchemy.destroy(scope);
    }
  });
});

async function assertMetadataIndexDeleted(
  indexName: string,
  propertyName: string,
) {
  const api = await createCloudflareApi();
  try {
    // List metadata indexes and check if our index is still there
    const metadataIndexes = await listMetadataIndexes(api, indexName);
    const foundIndex = metadataIndexes.find(
      (idx) => idx.propertyName === propertyName,
    );

    if (foundIndex) {
      throw new Error(
        `Metadata index ${propertyName} was not deleted as expected`,
      );
    }
  } catch (error: any) {
    // If we get a 404, the parent index itself might have been deleted (which is fine)
    if (error.status === 404 || error.status === 410) {
      return; // This is expected
    } else {
      throw new Error(`Unexpected error type: ${error}`);
    }
  }
}
