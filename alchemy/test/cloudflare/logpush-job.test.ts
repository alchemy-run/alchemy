import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { R2Bucket } from "../../src/cloudflare/bucket.ts";
import { LogPushJob } from "../../src/cloudflare/logpush-job.ts";
import { destroy } from "../../src/destroy.ts";
import "../../src/test/vitest.ts";
import { BRANCH_PREFIX } from "../util.ts";

/**
 * LogPush tests require R2 credentials because Cloudflare validates destinations
 * server-side by writing test data to them during job creation.
 */
const hasR2Credentials = !!(
  process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
);

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

/**
 * Verify logpush job exists via API
 */
async function assertLogPushJobExists(
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
async function assertLogPushJobDeleted(
  api: Awaited<ReturnType<typeof createCloudflareApi>>,
  jobId: number,
  attempt = 0,
): Promise<void> {
  const response = await api.get(
    `/accounts/${api.accountId}/logpush/jobs/${jobId}`,
  );

  if (response.status === 404) {
    return;
  }

  if (response.ok && attempt < 10) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return assertLogPushJobDeleted(api, jobId, attempt + 1);
  }

  throw new Error(`LogPush job ${jobId} was not deleted as expected`);
}

/**
 * Create a test LogPush destination using R2
 */
async function createTestDestination(
  testId: string,
  api: Awaited<ReturnType<typeof createCloudflareApi>>,
) {
  const bucketName = `${testId.toLowerCase().replace(/_/g, "-")}-logs`;
  const bucket = await R2Bucket(bucketName, {
    name: bucketName,
    empty: true,
    adopt: true,
  });

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables are required",
    );
  }

  return {
    bucket,
    destinationConf: `r2://${bucket.name}/logs/{DATE}?account-id=${api.accountId}&access-key-id=${accessKeyId}&secret-access-key=${secretAccessKey}`,
  };
}

describe("LogPushJob Resource Basic", () => {
  test("LogPushJob resource is exported and defined", async () => {
    expect(LogPushJob).toBeDefined();
    expect(typeof LogPushJob).toBe("function");
  });

  test("LogPushJob interface has correct type structure", async () => {
    const mockJob: Awaited<ReturnType<typeof LogPushJob>> = {
      type: "logpush_job",
      id: 12345,
      dataset: "http_requests",
      destinationConf: "s3://test-bucket/logs",
      enabled: true,
      name: "Test Job",
      accountId: "test-account",
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    };

    expect(mockJob.type).toBe("logpush_job");
    expect(mockJob.id).toBe(12345);
    expect(mockJob.dataset).toBe("http_requests");
    expect(mockJob.accountId).toBe("test-account");
    expect(typeof mockJob.createdAt).toBe("number");
    expect(typeof mockJob.modifiedAt).toBe("number");
  });
});

describe.skipIf(!hasR2Credentials)("LogPushJob Resource - Integration", () => {
  const testId = `${BRANCH_PREFIX}-logpush`;

  test("create, update, and delete account-level LogPush job", async (scope) => {
    let logPushJob: Awaited<ReturnType<typeof LogPushJob>> | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-basic`, api);

      logPushJob = await LogPushJob(testId, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `test-logpush-${testId}`,
        enabled: false,
        outputOptions: {
          outputType: "ndjson",
          timestampFormat: "rfc3339",
          fieldNames: ["RayID", "ClientIP", "EdgeStartTimestamp"],
        },
      });

      expect(logPushJob.id).toBeTruthy();
      expect(logPushJob.dataset).toBe("http_requests");
      expect(logPushJob.type).toBe("logpush_job");
      expect(logPushJob.enabled).toBe(false);
      expect(logPushJob.accountId).toBe(api.accountId);
      expect(logPushJob.outputOptions?.outputType).toBe("ndjson");

      await assertLogPushJobExists(api, logPushJob.id!);

      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logPushJob.id}`,
      );
      const data: any = await response.json();
      expect(data.result.dataset).toBe("http_requests");
      expect(data.result.name).toBe(`test-logpush-${testId}`);

      logPushJob = await LogPushJob(testId, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `updated-${testId}`,
        enabled: true,
      });

      expect(logPushJob.enabled).toBe(true);
      expect(logPushJob.name).toBe(`updated-${testId}`);

      const updatedResponse = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logPushJob.id}`,
      );
      const updatedData: any = await updatedResponse.json();
      expect(updatedData.result.enabled).toBe(true);
    } catch (err) {
      console.error("LogPush test error:", err);
      throw err;
    } finally {
      await destroy(scope);

      if (logPushJob?.id) {
        await assertLogPushJobDeleted(api, logPushJob.id);
      }
    }
  }, 120000);

  test("create LogPush job with output options", async (scope) => {
    let logPushJob: Awaited<ReturnType<typeof LogPushJob>> | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-output`, api);

      logPushJob = await LogPushJob(`${testId}-output`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `output-${testId}`,
        outputOptions: {
          outputType: "ndjson",
          timestampFormat: "rfc3339",
          fieldNames: ["ClientIP", "ClientRequestHost", "EdgeResponseStatus"],
        },
      });

      expect(logPushJob.outputOptions?.outputType).toBe("ndjson");

      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logPushJob.id}`,
      );
      const data: any = await response.json();
      expect(data.result.output_options.output_type).toBe("ndjson");
    } finally {
      await destroy(scope);
      if (logPushJob?.id) {
        await assertLogPushJobDeleted(api, logPushJob.id);
      }
    }
  }, 120000);

  test("create LogPush job with filter and sampling", async (scope) => {
    let logPushJob: Awaited<ReturnType<typeof LogPushJob>> | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-filter`, api);
      const filter =
        '{"where":{"and":[{"key":"ClientCountry","operator":"neq","value":"ca"}]}}';

      logPushJob = await LogPushJob(`${testId}-filter`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `filter-${testId}`,
        filter,
        sample: 0.5,
      });

      expect(logPushJob.filter).toBe(filter);
      expect(logPushJob.sample).toBe(0.5);

      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logPushJob.id}`,
      );
      const data: any = await response.json();
      expect(data.result.filter).toBe(filter);
      expect(data.result.sample).toBe(0.5);
    } finally {
      await destroy(scope);
      if (logPushJob?.id) {
        await assertLogPushJobDeleted(api, logPushJob.id);
      }
    }
  }, 120000);

  test("create LogPush job with frequency and batch settings", async (scope) => {
    let logPushJob: Awaited<ReturnType<typeof LogPushJob>> | undefined;
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(`${testId}-batch`, api);

      logPushJob = await LogPushJob(`${testId}-batch`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `batch-${testId}`,
        frequency: "low",
        maxUploadBytes: 5000000,
        maxUploadIntervalSeconds: 30,
        maxUploadRecords: 1000,
      });

      expect(logPushJob.frequency).toBe("low");
      expect(logPushJob.maxUploadBytes).toBe(5000000);

      const response = await api.get(
        `/accounts/${api.accountId}/logpush/jobs/${logPushJob.id}`,
      );
      const data: any = await response.json();
      expect(data.result.frequency).toBe("low");
      expect(data.result.max_upload_bytes).toBe(5000000);
    } finally {
      await destroy(scope);
      if (logPushJob?.id) {
        await assertLogPushJobDeleted(api, logPushJob.id);
      }
    }
  }, 120000);

  test("delete=false prevents job deletion", async (scope) => {
    const api = await createCloudflareApi();

    try {
      const destination = await createTestDestination(
        `${testId}-nodelete`,
        api,
      );

      const logPushJob = await LogPushJob(`${testId}-nodelete`, {
        dataset: "http_requests",
        destinationConf: destination.destinationConf,
        name: `nodelete-${testId}`,
        delete: false,
      });

      const jobId = logPushJob.id;

      await destroy(scope);
      await assertLogPushJobExists(api, jobId!);
      await api.delete(`/accounts/${api.accountId}/logpush/jobs/${jobId}`);
      await assertLogPushJobDeleted(api, jobId!);
    } catch (err) {
      console.error(err);
      throw err;
    }
  }, 120000);
});
