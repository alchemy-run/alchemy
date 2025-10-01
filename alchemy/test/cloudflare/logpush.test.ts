import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { R2Bucket } from "../../src/cloudflare/bucket";
import { Logpush } from "../../src/cloudflare/logpush";
import { destroy } from "../../src/destroy";
import "../../src/test/vitest";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

/**
 * Verify logpush job exists via API
 */
async function assertLogpushJobExists(
  api: Awaited<ReturnType<typeof createCloudflareApi>>,
  jobId: number,
): Promise<void> {
  const response = await api.get(
    `/accounts/${api.accountId}/logpush/jobs/${jobId}`,
  );
  expect(response.ok).toBe(true);
  const data: any = await response.json();
  expect(data.result.id).toBe(jobId);
}

/**
 * Verify logpush job was deleted (with retry for eventual consistency)
 */
async function assertLogpushJobDeleted(
  api: Awaited<ReturnType<typeof createCloudflareApi>>,
  jobId: number,
  attempt = 0,
): Promise<void> {
  const response = await api.get(
    `/accounts/${api.accountId}/logpush/jobs/${jobId}`,
  );

  if (response.status === 404) {
    return; // Success - job deleted
  }

  if (response.ok && attempt < 10) {
    // Job still exists, retry with backoff
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return assertLogpushJobDeleted(api, jobId, attempt + 1);
  }

  throw new Error(`Logpush job ${jobId} was not deleted as expected`);
}

/**
 * Create a temporary R2 bucket for Logpush destination
 * Requires R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables
 */
async function createTestDestination(
  testId: string,
  api: Awaited<ReturnType<typeof createCloudflareApi>>,
) {
  const bucketName = `${testId.toLowerCase().replace(/_/g, "-")}-logs`;
  const bucket = await R2Bucket(bucketName, {
    name: bucketName,
    empty: true, // Auto-empty on delete
    adopt: true, // Adopt existing if present
  });

  // R2 destination format for Logpush requires explicit credentials
  // Format: r2://bucket-name/path?account-id=XXX&access-key-id=YYY&secret-access-key=ZZZ
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables are required for Logpush R2 destination",
    );
  }

  return {
    bucket,
    destinationConf: `r2://${bucket.name}/logs/{DATE}?account-id=${api.accountId}&access-key-id=${accessKeyId}&secret-access-key=${secretAccessKey}`,
  };
}

// Check if R2 credentials are available for tests
const hasR2Credentials = !!(
  process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
);

// Basic smoke test that always runs
describe("Logpush Resource - Basic", () => {
  test("Logpush resource is exported and defined", async () => {
    expect(Logpush).toBeDefined();
    expect(typeof Logpush).toBe("function");
  });
});

// Integration tests that require R2 credentials
describe.skipIf(!hasR2Credentials)("Logpush Resource - Integration", () => {
  const testId = `${BRANCH_PREFIX}-logpush`;

  test("create, update, and delete account-level logpush job", async (scope) => {
    let logpush: Logpush | undefined;
    const api = await createCloudflareApi();

    try {
      // Create test destination (R2 bucket)
      const destination = await createTestDestination(`${testId}-basic`, api);

      // Create Logpush job
      logpush = await Logpush(testId, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `test-logpush-${testId}`,
        enabled: false,
        logpullOptions: "fields=RayID,ClientIP&timestamps=rfc3339",
      });

      // Assertions - verify resource properties
      expect(logpush.id).toBeTruthy();
      expect(logpush.dataset).toBe("http_requests");
      expect(logpush.scope).toBe("account");
      expect(logpush.enabled).toBe(false);
      expect(logpush.accountId).toBe(api.accountId);

      // Verify via API
      await assertLogpushJobExists(api, logpush.id);

      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logpush.id}`,
      );
      const data: any = await response.json();
      expect(data.result.dataset).toBe("http_requests");
      expect(data.result.name).toBe(`test-logpush-${testId}`);

      // Update the job
      logpush = await Logpush(testId, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `updated-${testId}`,
        enabled: true,
      });

      // Verify update
      expect(logpush.enabled).toBe(true);
      expect(logpush.name).toBe(`updated-${testId}`);

      const updatedResponse = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logpush.id}`,
      );
      const updatedData: any = await updatedResponse.json();
      expect(updatedData.result.enabled).toBe(true);
    } catch (err) {
      console.error("Logpush test error:", err);
      throw err;
    } finally {
      // Cleanup - always runs
      await destroy(scope);

      // Verify deletion
      if (logpush?.id) {
        await assertLogpushJobDeleted(api, logpush.id);
      }
    }
  }, 120000); // 2 minute timeout

  test("create logpush job with output options", async (scope) => {
    let logpush: Logpush | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-output`, api);

      logpush = await Logpush(`${testId}-output`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `output-${testId}`,
        outputOptions: {
          outputType: "ndjson",
          timestampFormat: "rfc3339",
          fieldNames: ["ClientIP", "ClientRequestHost", "EdgeResponseStatus"],
        },
      });

      expect(logpush.outputOptions?.outputType).toBe("ndjson");

      // Verify via API
      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logpush.id}`,
      );
      const data: any = await response.json();
      expect(data.result.output_options.output_type).toBe("ndjson");
    } finally {
      await destroy(scope);
      if (logpush?.id) {
        await assertLogpushJobDeleted(api, logpush.id);
      }
    }
  }, 120000);

  test("create logpush job with filter and sampling", async (scope) => {
    let logpush: Logpush | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-filter`, api);
      const filter =
        '{"where":{"and":[{"key":"ClientCountry","operator":"neq","value":"ca"}]}}';

      logpush = await Logpush(`${testId}-filter`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `filter-${testId}`,
        filter,
        sample: 0.5, // 50% sampling
      });

      expect(logpush.filter).toBe(filter);
      expect(logpush.sample).toBe(0.5);

      // Verify via API
      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logpush.id}`,
      );
      const data: any = await response.json();
      expect(data.result.filter).toBe(filter);
      expect(data.result.sample).toBe(0.5);
    } finally {
      await destroy(scope);
      if (logpush?.id) {
        await assertLogpushJobDeleted(api, logpush.id);
      }
    }
  }, 120000);

  test("create logpush job with frequency and batch settings", async (scope) => {
    let logpush: Logpush | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-batch`, api);

      logpush = await Logpush(`${testId}-batch`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `batch-${testId}`,
        frequency: "low",
        maxUploadBytes: 5000000,
        maxUploadIntervalSeconds: 30,
        maxUploadRecords: 1000,
      });

      expect(logpush.frequency).toBe("low");
      expect(logpush.maxUploadBytes).toBe(5000000);

      // Verify via API
      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logpush.id}`,
      );
      const data: any = await response.json();
      expect(data.result.frequency).toBe("low");
      expect(data.result.max_upload_bytes).toBe(5000000);
    } finally {
      await destroy(scope);
      if (logpush?.id) {
        await assertLogpushJobDeleted(api, logpush.id);
      }
    }
  }, 120000);

  test("delete=false prevents job deletion", async (scope) => {
    let logpush: Logpush | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(
        `${testId}-nodelete`,
        api,
      );

      // Create with delete: false
      logpush = await Logpush(`${testId}-nodelete`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `nodelete-${testId}`,
        delete: false,
      });

      const jobId = logpush.id;

      // Destroy should not delete the job
      await destroy(scope);

      // Verify job still exists
      await assertLogpushJobExists(api, jobId);

      // Manual cleanup
      await api.delete(`/accounts/${api.accountId}/logpush/jobs/${jobId}`);
      await assertLogpushJobDeleted(api, jobId);
    } catch (err) {
      console.error(err);
      throw err;
    }
  }, 120000);
});

/**
 * Running the Integration Tests:
 *
 * The integration tests require R2 API tokens to create temporary R2 buckets
 * as Logpush destinations. These credentials cannot be programmatically created
 * and must be provided via environment variables.
 *
 * Setup:
 * 1. Create R2 API tokens in Cloudflare dashboard:
 *    - Go to: R2 > Manage R2 API Tokens
 *    - Create a token with "Admin Read & Write" permissions
 *
 * 2. Set environment variables:
 *    export R2_ACCESS_KEY_ID="your-access-key-id"
 *    export R2_SECRET_ACCESS_KEY="your-secret-access-key"
 *
 * 3. Run tests:
 *    bunx vitest alchemy/test/cloudflare/logpush.test.ts
 *
 * Note: Tests will be skipped if credentials are not provided
 *
 * @see https://developers.cloudflare.com/r2/api/s3/tokens/
 * @see https://developers.cloudflare.com/logs/get-started/enable-destinations/r2/
 */
