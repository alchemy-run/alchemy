import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { createVercelApi } from "../../src/vercel/api.ts";
import { Project } from "../../src/vercel/project.ts";
import { BRANCH_PREFIX } from "../util.ts";

// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";

const api = await createVercelApi({
  baseUrl: "https://api.vercel.com/v11",
});

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Vercel Project Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-project`;

  // TODO(sam): re-enable these after merging
  test("create, update, and delete project", async (scope) => {
    let project: Project | undefined;
    try {
      // Create a test project
      project = await Project(testId, {
        name: testId,
        framework: "astro",
        environmentVariables: [
          {
            key: "TEST_DEFAULT_PLAIN_VAR",
            target: ["production", "preview", "development"],
            // Defaults to `type: "plain"`
            value: "test",
          },
          {
            key: "TEST_PLAIN_VAR",
            target: ["production", "preview", "development"],
            type: "plain",
            value: "test",
          },
          {
            key: "TEST_DEFAULT_ENCRYPTED_VAR",
            target: ["production", "preview", "development"],
            // Defaults to `type: "encrypted"`
            value: alchemy.secret("test"),
          },
          {
            key: "TEST_ENCRYPTED_VAR",
            target: ["production", "preview", "development"],
            type: "encrypted",
            value: alchemy.secret("test"),
          },
          {
            key: "TEST_SENSITIVE_VAR",
            target: ["production", "preview"],
            type: "sensitive",
            value: alchemy.secret("test"),
          },
        ],
      });

      expect(project.id).toBeTruthy();
      expect(project.name).toEqual(testId);

      // Verify project was created by querying the API directly
      const getResponse = await api.get(`/projects/${project.id}`);
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.name).toEqual(testId);

      // Update the project
      project = await Project(testId, {
        name: testId,
        framework: "nextjs",
        buildCommand: "next build",
        environmentVariables: [
          {
            key: "TEST_PLAIN_VAR",
            target: ["production", "preview", "development"],
            type: "plain",
            value: "test",
          },
        ],
      });

      expect(project.id).toEqual(project.id);
      expect(project.name).toEqual(testId);
      expect(project.buildCommand).toEqual("next build");

      // Verify project was updated
      const getUpdatedResponse = await api.get(`/projects/${project.id}`);
      const updatedData: any = await getUpdatedResponse.json();
      expect(updatedData.name).toEqual(testId);
      expect(updatedData.buildCommand).toEqual("next build");
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify project was deleted
      const getDeletedResponse = await api
        .get(`/projects/${project?.id}`)
        .catch((error) => error);

      expect(getDeletedResponse.code).toEqual("not_found");
      expect(getDeletedResponse.cause.status).toEqual(404);
    }
  });
});
