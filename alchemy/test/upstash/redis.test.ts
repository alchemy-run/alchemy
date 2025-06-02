import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import {
  UpstashApi,
  UpstashError,
  UpstashRedis,
} from "../../src/upstash/index.js";
import { getRedisDatabase } from "../../src/upstash/redis.js";
import { BRANCH_PREFIX } from "../util.js";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.js";

const api = new UpstashApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("UpstashRedis Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-redis`;

  test("create, update, and delete redis database", async (scope) => {
    let redis: UpstashRedis | undefined;
    try {
      // Create a test database
      redis = await UpstashRedis(testId, {
        name: testId,
        primaryRegion: "us-east-1",
        eviction: true, // Explicitly set eviction
      });

      expect(redis.id).toBeTruthy();
      expect(redis.name).toEqual(testId);
      expect(redis.primaryRegion).toEqual("us-east-1");
      expect(redis.databaseType).toBeTruthy();
      expect(redis.region).toEqual("global");
      expect(redis.port).toBeGreaterThan(0);
      expect(redis.createdAt).toBeGreaterThan(0);
      expect(redis.state).toEqual("active");
      expect(redis.password).toBeTruthy();
      expect(redis.userEmail).toBeTruthy();
      expect(redis.endpoint).toBeTruthy();
      expect(redis.tls).toEqual(true);
      expect(redis.restToken).toBeTruthy();
      expect(redis.readOnlyRestToken).toBeTruthy();
      expect(redis.eviction).toBe(true);

      // Verify database was created by querying the API directly using the extracted function
      const databaseData = await getRedisDatabase(api, redis.id);
      expect(databaseData.database_name).toEqual(testId);
      expect(databaseData.eviction).toEqual(true);

      // Update the database
      redis = await UpstashRedis(testId, {
        name: `${testId}-updated`,
        primaryRegion: "us-east-1",
        readRegions: ["us-west-1"],
        eviction: false, // Explicitly set eviction to false
      });

      expect(redis.id).toEqual(redis.id);
      expect(redis.name).toEqual(`${testId}-updated`);
      expect(redis.readRegions).toEqual(["us-west-1"]);
      expect(redis.primaryRegion).toEqual("us-east-1");
      expect(redis.databaseType).toBeTruthy();
      expect(redis.region).toEqual("global");
      expect(redis.port).toBeGreaterThan(0);
      expect(redis.createdAt).toBeGreaterThan(0);
      expect(redis.state).toEqual("active");
      expect(redis.password).toBeTruthy();
      expect(redis.userEmail).toBeTruthy();
      expect(redis.endpoint).toBeTruthy();
      expect(redis.tls).toEqual(true);
      expect(redis.restToken).toBeTruthy();
      expect(redis.readOnlyRestToken).toBeTruthy();
      expect(redis.eviction).toEqual(false);

      // Verify database was updated using the extracted function
      const updatedData = await getRedisDatabase(api, redis.id);
      expect(updatedData.database_name).toEqual(`${testId}-updated`);
      expect(updatedData.read_regions).toEqual(["us-west-1"]);
      expect(updatedData.eviction).toEqual(false);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify database was deleted by checking if it returns a 404
      try {
        await getRedisDatabase(api, redis?.id || "");
        // If we reach here, the database still exists
        throw new Error("Database was not deleted");
      } catch (error) {
        // Expected to fail with a 404 error
        expect(error).toBeInstanceOf(UpstashError);
        const upstashError = error as UpstashError;
        expect(upstashError.statusCode).toEqual(404);
      }
    }
  });
});
