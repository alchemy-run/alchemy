import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.js";
import { destroy } from "../../src/destroy.js";
import { ProjectDomain } from "../../src/vercel/project-domain.js";
import { Project } from "../../src/vercel/project.js";
import { BRANCH_PREFIX } from "../util.js";

// must import this or else alchemy.test won't exist
import "../../src/test/vitest.js";
import { createVercelApi } from "../../src/vercel/api.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const api = await createVercelApi({
  baseUrl: "https://api.vercel.com/v9",
});

describe("ProjectDomain Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testId = `${BRANCH_PREFIX}-test-domain`;

  test("create, update, and delete domain", async (scope) => {
    let domain: ProjectDomain | undefined;
    let project: Project | undefined;

    try {
      project = await Project(`${BRANCH_PREFIX}-test-project`, {
        name: testId,
        framework: "nextjs",
      });

      // Create a test domain
      domain = await ProjectDomain(testId, {
        name: `test-${testId}.example.com`,
        project: project.name,
      });

      expect(domain.name).toEqual(`test-${testId}.example.com`);
      expect(domain.verified).toEqual(false);
      expect(domain.verification).toBeInstanceOf(Array);

      // Verify domain was created by querying the API directly
      const getResponse = await api.get(
        `/projects/${project.name}/domains/${domain.name}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.name).toEqual(`test-${testId}.example.com`);

      // Update the domain
      domain = await ProjectDomain(testId, {
        name: `test-${testId}.vercel.app`,
        project: project.name,
        gitBranch: "main",
      });

      expect(domain.name).toEqual(`test-${testId}.example.com`);
      expect(domain.gitBranch).toEqual("main");

      // Verify domain was updated
      const getUpdatedResponse = await api.get(
        `/projects/${project.name}/domains/${domain.name}`,
      );
      const updatedData: any = await getUpdatedResponse.json();
      expect(updatedData.name).toEqual(`test-${testId}.example.com`);
      expect(updatedData.gitBranch).toEqual("main");
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify domain was deleted
      const error = await api
        .get(`/projects/${project?.name}/domains/${domain?.name}`)
        .catch((error) => error);

      expect(error.cause.status).toEqual(404);
    }
  });
});
