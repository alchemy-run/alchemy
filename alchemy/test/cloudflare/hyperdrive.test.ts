import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import {
  Hyperdrive,
  type HyperdriveResource,
} from "../../src/cloudflare/hyperdrive.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { destroy } from "../../src/destroy.ts";
import { NeonProject } from "../../src/neon/project.ts";
import { BRANCH_PREFIX } from "../util.ts";
import { fetchAndExpectOK } from "./fetch-utils.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

// Create API client for verification
const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Hyperdrive Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-hyperdrive`;

  test("create, update, and delete hyperdrive with Neon project", async (scope) => {
    let hyperdrive: HyperdriveResource | undefined;
    let project: NeonProject | undefined;
    let worker: Worker | undefined;

    try {
      // First create a Neon PostgreSQL project
      project = await NeonProject(`${testId}-db`, {
        name: `Hyperdrive Test DB ${BRANCH_PREFIX}`,
      });

      expect(project.id).toBeTruthy();
      expect(project.connection_uris.length).toBeGreaterThan(0);

      console.log(project.connection_uris[0].connection_parameters);

      // Create a test Hyperdrive using the Neon project's connection parameters
      hyperdrive = await Hyperdrive(testId, {
        name: `test-hyperdrive-${BRANCH_PREFIX}`,
        origin: project.connection_uris[0].connection_parameters,
      });

      expect(hyperdrive.id).toEqual(testId);
      expect(hyperdrive.name).toEqual(`test-hyperdrive-${BRANCH_PREFIX}`);
      expect(hyperdrive.origin.host).toEqual(
        project.connection_uris[0].connection_parameters.host,
      );
      expect(hyperdrive.origin.database).toEqual(
        project.connection_uris[0].connection_parameters.database,
      );
      expect(hyperdrive.hyperdriveId).toBeTruthy(); // Check that we got a hyperdriveId

      // Verify hyperdrive was created by querying the API directly
      const getResponse = await api.get(
        `/accounts/${api.accountId}/hyperdrive/configs/${hyperdrive.hyperdriveId}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.result.name).toEqual(
        `test-hyperdrive-${BRANCH_PREFIX}`,
      );
      expect(responseData.result.origin.host).toEqual(
        project.connection_uris[0].connection_parameters.host,
      );

      // Create a simple worker script to test the connection

      // Deploy a worker that uses the hyperdrive
      const workerName = `${BRANCH_PREFIX}-hyperdrive-test-worker`;
      worker = await Worker(workerName, {
        name: workerName,
        script: `
          export default {
            async fetch(request, env, ctx) {
              if (typeof env.DB?.connect === "function") {
                return new Response("OK", { status: 200 });
              } else {
                return new Response("DB not found", { status: 500 });
              }
            }
          };
        `,
        format: "esm",
        url: true,
        bindings: {
          DB: hyperdrive,
        },
      });

      expect(worker.url).toBeTruthy();

      // Test the connection works
      await fetchAndExpectOK(worker.url!);

      // Update the hyperdrive
      hyperdrive = await Hyperdrive(testId, {
        name: `updated-hyperdrive-${BRANCH_PREFIX}`,
        hyperdriveId: hyperdrive.hyperdriveId, // Pass the hyperdriveId
        origin: project.connection_uris[0].connection_parameters,
        caching: {
          disabled: true,
        },
      });

      expect(hyperdrive.id).toEqual(testId);
      expect(hyperdrive.name).toEqual(`updated-hyperdrive-${BRANCH_PREFIX}`);
      expect(hyperdrive.caching?.disabled).toEqual(true);

      // Verify hyperdrive was updated
      const getUpdatedResponse = await api.get(
        `/accounts/${api.accountId}/hyperdrive/configs/${hyperdrive.hyperdriveId}`,
      );
      const updatedData: any = await getUpdatedResponse.json();
      expect(updatedData.result.name).toEqual(
        `updated-hyperdrive-${BRANCH_PREFIX}`,
      );
      expect(updatedData.result.caching.disabled).toEqual(true);
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
});
