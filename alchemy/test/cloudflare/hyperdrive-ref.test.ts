import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { HyperdriveRef } from "../../src/cloudflare/hyperdrive-ref.ts";
import { Hyperdrive } from "../../src/cloudflare/hyperdrive.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { destroy } from "../../src/destroy.ts";
import { NeonProject } from "../../src/neon/project.ts";
import { fetchAndExpectOK } from "../../src/util/safe-fetch.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

// Create API client for verification
const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe.concurrent("HyperdriveRef Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-hyperdrive-ref`;

  test("create hyperdrive, reference it with HyperdriveRef, and bind to worker", async (scope) => {
    let hyperdrive: Hyperdrive | undefined;
    let hyperdriveRef: HyperdriveRef | undefined;
    let worker: Worker | undefined;
    let project: NeonProject | undefined;

    try {
      // First create a Neon PostgreSQL project
      project = await NeonProject(`${testId}-db`, {
        name: `HyperdriveRef Test DB ${BRANCH_PREFIX}`,
      });

      expect(project.id).toBeTruthy();
      expect(project.connection_uris.length).toBeGreaterThan(0);

      // Create a test Hyperdrive using the Neon project's connection parameters
      hyperdrive = await Hyperdrive(testId, {
        name: `test-hyperdrive-ref-${BRANCH_PREFIX}`,
        origin: project.connection_uris[0].connection_parameters,
        dev: {
          origin: "postgres://postgres:postgres@localhost:5432/postgres",
        },
      });

      expect(hyperdrive.id).toEqual(testId);
      expect(hyperdrive.name).toEqual(`test-hyperdrive-ref-${BRANCH_PREFIX}`);
      expect(hyperdrive.hyperdriveId).toBeTruthy();

      // Verify hyperdrive was created by querying the API directly
      const getResponse = await api.get(
        `/accounts/${api.accountId}/hyperdrive/configs/${hyperdrive.hyperdriveId}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.result.name).toEqual(
        `test-hyperdrive-ref-${BRANCH_PREFIX}`,
      );

      // Now create a HyperdriveRef that references the existing hyperdrive by name
      hyperdriveRef = await HyperdriveRef({
        name: `test-hyperdrive-ref-${BRANCH_PREFIX}`,
      });

      expect(hyperdriveRef.type).toEqual("hyperdrive");
      expect(hyperdriveRef.name).toEqual(
        `test-hyperdrive-ref-${BRANCH_PREFIX}`,
      );
      expect(hyperdriveRef.hyperdriveId).toEqual(hyperdrive.hyperdriveId);

      // Deploy a worker that uses the hyperdrive reference
      const workerName = `${BRANCH_PREFIX}-hyperdrive-ref-test-worker`;
      worker = await Worker(workerName, {
        name: workerName,
        adopt: true,
        script: `
          export default {
            async fetch(request, env, ctx) {
              if (typeof env.DB?.connect === "function") {
                return new Response("HyperdriveRef OK", { status: 200 });
              } else {
                return new Response("DB not found", { status: 500 });
              }
            }
          };
        `,
        format: "esm",
        url: true,
        bindings: {
          DB: hyperdriveRef,
        },
      });

      expect(worker.url).toBeTruthy();

      // Test the connection works through the reference
      const response = await fetchAndExpectOK(worker.url!);
      const text = await response.text();
      expect(text).toEqual("HyperdriveRef OK");
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify hyperdrive was deleted
      if (hyperdrive?.hyperdriveId) {
        const getDeletedResponse = await api.get(
          `/accounts/${api.accountId}/hyperdrive/configs/${hyperdrive.hyperdriveId}`,
        );
        expect(getDeletedResponse.status).toEqual(404);
      }
    }
  });

  test("HyperdriveRef with both name and id", async (scope) => {
    let hyperdrive: Hyperdrive | undefined;
    let hyperdriveRef: HyperdriveRef | undefined;
    let project: NeonProject | undefined;

    try {
      // First create a Neon PostgreSQL project
      project = await NeonProject(`${testId}-both-db`, {
        name: `HyperdriveRef Both Test DB ${BRANCH_PREFIX}`,
      });

      // Create a test Hyperdrive
      hyperdrive = await Hyperdrive(`${testId}-both`, {
        name: `test-hyperdrive-ref-both-${BRANCH_PREFIX}`,
        origin: project.connection_uris[0].connection_parameters,
      });

      expect(hyperdrive.hyperdriveId).toBeTruthy();

      // Create a HyperdriveRef with both name and id
      hyperdriveRef = await HyperdriveRef({
        name: `test-hyperdrive-ref-both-${BRANCH_PREFIX}`,
        id: hyperdrive.hyperdriveId,
      });

      expect(hyperdriveRef.type).toEqual("hyperdrive");
      expect(hyperdriveRef.name).toEqual(
        `test-hyperdrive-ref-both-${BRANCH_PREFIX}`,
      );
      expect(hyperdriveRef.hyperdriveId).toEqual(hyperdrive.hyperdriveId);
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);
    }
  });

  test("HyperdriveRef throws error when hyperdrive not found", async (scope) => {
    try {
      // Try to reference a non-existent hyperdrive
      await expect(
        HyperdriveRef({
          name: `non-existent-hyperdrive-${BRANCH_PREFIX}`,
        }),
      ).rejects.toThrow(
        `Hyperdrive config with name "non-existent-hyperdrive-${BRANCH_PREFIX}" not found`,
      );
    } finally {
      await destroy(scope);
    }
  });

  test("HyperdriveRef throws error when no name provided", async (scope) => {
    try {
      // Try to create HyperdriveRef without name
      await expect(
        HyperdriveRef({
          id: "some-id",
        }),
      ).rejects.toThrow(
        "HyperdriveRef requires either name or both name and id",
      );
    } finally {
      await destroy(scope);
    }
  });

  test("HyperdriveRef throws error when neither name nor id provided", async (scope) => {
    try {
      // Try to create HyperdriveRef without name or id
      await expect(HyperdriveRef({})).rejects.toThrow(
        "HyperdriveRef requires at least a name",
      );
    } finally {
      await destroy(scope);
    }
  });
});
