import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  fetchPage,
  getStorageAccount,
  LOCATION,
  logLevel,
  storageWebUrl,
  tempRoot,
  waitForPage,
  webBlob,
} from "./site.ts";

// `dev: true` runs the local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const tags = ["provider:azure", "provider:azure:website", "local"];

/** A dev server's own address: `http://localhost:<port>` or `http://127.0.0.1:<port>`. */
const localUrl = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/;

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/astro-app");
const fixtureEntries = [".gitignore", "package.json", "astro.config.mjs", "src", "public"];
const memo = { include: ["src/**", "public/**", "package.json", "astro.config.mjs"] };

const clone = (prefix: string) =>
  cloneFixture(fixtureDir, { prefix, tempRoot, entries: fixtureEntries });

describe("Azure.Website.Astro local", { tags }, () => {
  test.provider(
    "alchemy dev runs Astro's own dev server with no Azure resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* clone("alchemy-astro-azure-local-");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Astro("Web", { rootDir });
          }),
        );
        expect(site.url as string).toMatch(localUrl);
        expect(site.resourceGroup).toBeUndefined();
        expect(site.storageAccount).toBeUndefined();
        expect(site.assets).toBeUndefined();
        expect(site.server).toBeUndefined();
        expect(site.frontDoor).toBeUndefined();
        const url = (site.url as string).replace(/\/$/, "");

        // The dev server renders on demand and runs API routes.
        const home = yield* waitForPage(
          `${url}/`,
          (page) => page.status === 200 && page.body.includes("ASTRO_AWS_PAGE_MARKER"),
          { spacing: "2 seconds", times: 45 },
        );
        expect(home.body).toMatch(/id="mode"[^>]*>on-demand</);
        const api = yield* fetchPage(`${url}/api/hello?echo=dev`);
        expect(JSON.parse(api.body)).toEqual({ marker: "ASTRO_AWS_API_MARKER", echo: "dev" });

        // An edit shows up on the next request without a redeploy.
        const fs = yield* FileSystem.FileSystem;
        const helloPath = `${rootDir}/src/pages/api/hello.ts`;
        const source = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          source.replace('"ASTRO_AWS_API_MARKER"', '"ASTRO_AZURE_DEV_EDIT"'),
        );
        const edited = yield* waitForPage(`${url}/api/hello?echo=dev`, (page) =>
          page.body.includes("ASTRO_AZURE_DEV_EDIT"),
        );
        expect(JSON.parse(edited.body)).toEqual({ marker: "ASTRO_AZURE_DEV_EDIT", echo: "dev" });

        yield* stack.destroy();
        const gone = yield* fetchPage(`${url}/`).pipe(
          Effect.as("serving" as const),
          Effect.catch(() => Effect.succeed("stopped" as const)),
        );
        expect(gone).toBe("stopped");
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // ~$0.01/run (one Standard_LRS account); ~5 min. A static build without
  // Front Door keeps the remote deploy off the 30-minute profile delete.
  test.provider(
    "Alchemy.remote() deploys the site to Azure during dev",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* clone("alchemy-astro-azure-remote-");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Astro("Web", {
              rootDir,
              location: LOCATION,
              astro: { output: "static" },
              frontDoor: false,
              memo,
            });
          }).pipe(Alchemy.remote()),
        );
        const url = site.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(site.server).toBeUndefined();
        const account = site.storageAccount!.storageAccountName;
        expect(site.storageAccount!.storageAccountId).toMatch(/^\/subscriptions\//);

        // Out of band: the prerendered pages are in the real account's `$web`.
        const index = yield* webBlob(account, "index.html");
        expect(index?.contentType).toBe("text/html; charset=utf-8");
        // The Node serve entry the build wrote into the client directory stays local.
        expect(yield* webBlob(account, "serve-node.mjs")).toBeUndefined();
        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(home.body).toContain("ASTRO_AWS_PAGE_MARKER");
        const prerendered = yield* fetchPage(`${url}/prerendered/`);
        expect(prerendered.body).toContain("ASTRO_AWS_PRERENDERED_MARKER");

        // Destroy deletes the live account (rows stamped `live`).
        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        expect(yield* getStorageAccount(groupName, account)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
