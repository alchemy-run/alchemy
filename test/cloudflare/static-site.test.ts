import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { apply } from "../../alchemy/src/apply";
import { createCloudflareApi } from "../../alchemy/src/cloudflare/api";
import { StaticSite } from "../../alchemy/src/cloudflare/static-site";
import { Worker } from "../../alchemy/src/cloudflare/worker";
import { destroy } from "../../alchemy/src/destroy";

// Check that required environment variables are set
const apiKey =
  process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!apiKey) {
  console.warn(
    "Skipping tests: CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY is required",
  );
}

describe("StaticSite Resource", () => {
  const testId = `test-static-site`;
  let tempDir: string;

  // Create temp dir with test files
  beforeAll(async () => {
    // if (!apiKey) return; // Skip setup if no credentials

    tempDir = path.join(".test", `cf-static-site-test`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create index.html
    await fs.writeFile(
      path.join(tempDir, "index.html"),
      "<html><body><h1>Hello World</h1></body></html>",
    );

    // Create styles.css
    await fs.writeFile(
      path.join(tempDir, "styles.css"),
      "body { font-family: Arial, sans-serif; }",
    );

    // Create a subfolder and file
    await fs.mkdir(path.join(tempDir, "js"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "js", "app.js"),
      "console.log('Hello from app.js');",
    );
  });

  // Clean up temp dir
  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Error cleaning up temp dir:", error);
    }
  });

  test("create, verify, and delete static site", async () => {
    // Create a static site
    const site = new StaticSite(testId, {
      name: testId,
      dir: tempDir,
    });

    // Verify site was created by trying to access the Worker
    const api = await createCloudflareApi();
    try {
      // Apply to create the site
      const output = await apply(site, {
        quiet: false,
      });

      expect(output.id).toBeTruthy();
      expect(output.workerId).toBeTruthy(); // Verify worker ID is set
      expect(output.assets.length).toBeGreaterThan(0);
      expect(output.assets).toContain("index.html");
      expect(output.assets).toContain("styles.css");
      expect(output.assets).toContain("js/app.js");

      const getResponse = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${testId}`,
      );
      expect(getResponse.status).toEqual(200);

      // Add a new file to the site for update testing
      // await fs.writeFile(
      //   path.join(tempDir, "new-page.html"),
      //   "<html><body><h1>New Page</h1></body></html>",
      // );

      // site = new StaticSite(testId, {
      //   name: testId,
      //   dir: tempDir,
      // });

      // // Update the site
      // const updateOutput = await apply(site);
      // expect(updateOutput.assets.length).toBeGreaterThan(output.assets.length);
      // expect(updateOutput.assets).toContain("new-page.html");
    } catch (error) {
      console.error("Error updating site:", error);
      throw error;
    } finally {
      // Clean up
      await destroy(site, {
        quiet: false,
      });

      // Verify site was deleted
      const getDeletedResponse = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${testId}`,
      );
      expect(getDeletedResponse.status).toEqual(404);
    }
  });

  test("static site with backend worker", async () => {
    if (!apiKey) return; // Skip test if no credentials

    // Create a backend worker script file
    const backendScriptPath = path.join(tempDir, "backend-worker.ts");
    await fs.writeFile(
      backendScriptPath,
      `
export interface Env {
  // Define any bindings your worker needs
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Add the request path to the response for verification
    const url = new URL(request.url);
    return new Response("Hello from backend worker! Path: " + url.pathname, {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
`,
    );

    // Create a static site with backend worker configuration
    const siteName = `${testId}-with-backend`;

    const backend = new Worker(`${siteName}-backend`, {
      name: `${siteName}-backend`,
      entrypoint: backendScriptPath,
    });

    const site = new StaticSite(siteName, {
      name: siteName,
      dir: tempDir,
      routes: {
        "/api/*": backend,
      },
      bundle: {
        minify: false,
      },
    });

    // Verify site and backend worker were created
    const api = await createCloudflareApi();
    try {
      // Apply to create the site with backend worker
      const output = await apply(site, {
        quiet: false,
      });

      // Verify main outputs
      expect(output.id).toBeTruthy();
      expect(output.workerId).toBeTruthy();
      expect(output.assets.length).toBeGreaterThan(0);

      // Verify main worker exists
      const getMainResponse = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${siteName}`,
      );
      expect(getMainResponse.status).toEqual(200);

      // Verify backend worker exists
      const getBackendResponse = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${siteName}-backend`,
      );
      expect(getBackendResponse.status).toEqual(200);

      // Verify the worker URL is provided
      expect(output.url).toBeTruthy();

      if (output.url) {
        // Test the worker's routing behavior - this path doesn't exist as a static file
        // so it should be routed to the backend worker
        const testPath = "/api/test";
        const workerResponse = await fetch(`${output.url}${testPath}`);

        // Check status and content type
        // expect(workerResponse.status).toEqual(200);
        // expect(workerResponse.headers.get("content-type")).toContain(
        //   "text/plain",
        // );

        // Check response body to confirm it came from our backend worker
        const responseText = await workerResponse.text();
        console.log("responseText", responseText);
        expect(responseText).toContain("Hello from backend worker!");
        expect(responseText).toContain(`Path: ${testPath}`);
      }
    } catch (error) {
      console.error("Error creating site with backend worker:", error);
      throw error;
    } finally {
      // Clean up
      await destroy(site, {
        quiet: false,
      });
      await destroy(backend, {
        quiet: false,
      });
      // Verify site was deleted
      const getDeletedResponse = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${siteName}`,
      );
      expect(getDeletedResponse.status).toEqual(404);
      // Verify backend worker was deleted (should be handled by dependencies)
      const getBackendDeletedResponse = await api.get(
        `/accounts/${api.accountId}/workers/scripts/${siteName}-backend`,
      );
      expect(getBackendDeletedResponse.status).toEqual(404);
    }
  });
});
