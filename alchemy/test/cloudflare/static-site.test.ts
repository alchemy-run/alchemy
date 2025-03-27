import { afterAll, beforeAll, describe, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { StaticSite } from "../../src/cloudflare/static-site";
import { Worker } from "../../src/cloudflare/worker";
import { destroy } from "../../src/destroy";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta);

describe("StaticSite Resource", () => {
  let tempDir: string;

  // Create temp dir with test files
  beforeAll(async () => {
    tempDir = path.join(".test", `${BRANCH_PREFIX}-cf-static-site-test`);
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
    // if (!apiKey) return; // Skip cleanup if no credentials
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Failed to clean up temp dir:", e);
    }
  });

  test(
    "create, update, and delete static site",
    {
      // quiet: true,
    },
    async (scope) => {
      const siteName = `${BRANCH_PREFIX}-test-static-site`;

      try {
        const site = await StaticSite(siteName, {
          name: siteName,
          dir: tempDir,
          bundle: {
            minify: false,
          },
        });
        expect(site.workerId).toBeTruthy();
        expect(site.assets.length).toBeGreaterThan(0);

        // Verify with Cloudflare API directly
        const api = await createCloudflareApi();
        const response = await api.get(
          `/accounts/${api.accountId}/workers/scripts/${siteName}`,
        );
        expect(response.status).toEqual(200);

        // Verify the worker URL is provided
        expect(site.url).toBeTruthy();

        if (site.url) {
          // Test the worker URL directly
          const indexResponse = await fetch(site.url);
          expect(indexResponse.status).toEqual(200);
          expect(indexResponse.headers.get("content-type")).toContain(
            "text/html",
          );

          // Test CSS file
          const cssResponse = await fetch(`${site.url}/styles.css`);
          expect(cssResponse.status).toEqual(200);
          expect(cssResponse.headers.get("content-type")).toContain("text/css");

          // Test JS file in subfolder
          const jsResponse = await fetch(`${site.url}/js/app.js`);
          expect(jsResponse.status).toEqual(200);
          expect(jsResponse.headers.get("content-type")).toContain(
            "javascript",
          );
        }
      } finally {
        // Clean up
        await destroy(scope);

        // Verify site was deleted
        const api = await createCloudflareApi();
        const response = await api.get(
          `/accounts/${api.accountId}/workers/scripts/${siteName}`,
        );
        expect(response.status).toEqual(404);
      }
    },
  );

  test("create static site with backend worker", async (scope) => {
    // Create a small backend worker script
    const backendScriptPath = path.join(tempDir, "backend.js");
    await fs.writeFile(
      backendScriptPath,
      `
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          return new Response('Hello from backend worker! Path: ' + url.pathname, {
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      };
      `,
    );

    const siteName = `${BRANCH_PREFIX}-test-static-site-with-backend`;

    // Verify site and backend worker were created
    const api = await createCloudflareApi();

    try {
      const backend = await Worker(`${siteName}-backend`, {
        name: `${siteName}-backend`,
        entrypoint: backendScriptPath,
      });

      const site = await StaticSite(siteName, {
        name: siteName,
        dir: tempDir,
        routes: {
          "/api/*": backend,
        },
        bundle: {
          minify: false,
        },
      });

      // Verify main outputs
      expect(site.workerId).toBeTruthy();
      expect(site.assets.length).toBeGreaterThan(0);

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
      expect(site.url).toBeTruthy();

      if (site.url) {
        // Test the worker's routing behavior - this path doesn't exist as a static file
        // so it should be routed to the backend worker
        const testPath = "/api/test";
        const workerResponse = await fetch(`${site.url}${testPath}`);

        // Check status and content type
        // expect(workerResponse.status).toEqual(200);
        // expect(workerResponse.headers.get("content-type")).toContain(
        //   "text/plain",
        // );

        // Check response body to confirm it came from our backend worker
        const responseText = await workerResponse.text();
        expect(responseText).toContain("Hello from backend worker!");
        expect(responseText).toContain(`Path: ${testPath}`);
      }
    } catch (error) {
      console.error("Error creating site with backend worker:", error);
      throw error;
    } finally {
      // Clean up
      await destroy(scope);

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
