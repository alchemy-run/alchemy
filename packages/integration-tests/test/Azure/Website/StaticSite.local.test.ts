import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  fetchPage,
  fixture,
  getStorageAccount,
  LOCATION,
  logLevel,
  staticWebsiteEnabled,
  storageWebUrl,
  waitForPage,
  tempRoot,
  webBlob,
} from "./site.ts";

// `dev: true` runs the local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const tags = ["provider:azure", "provider:azure:website", "local"];

/** A dev server's own address: `http://localhost:<port>` or `http://127.0.0.1:<port>`. */
const localUrl = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/;

const clone = (prefix: string) => cloneFixture(fixture("static-site"), { prefix, tempRoot });

/** No Azure resource backs a local site. */
const expectNoCloudResources = (
  site: Record<"resourceGroup" | "storageAccount" | "assets" | "server" | "frontDoor", unknown>,
) => {
  expect(site.resourceGroup).toBeUndefined();
  expect(site.storageAccount).toBeUndefined();
  expect(site.assets).toBeUndefined();
  expect(site.server).toBeUndefined();
  expect(site.frontDoor).toBeUndefined();
};

describe("Azure.Website.StaticSite local", { tags }, () => {
  test.provider(
    "without dev, alchemy dev builds outdir and serves it on a local static server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const docsCwd = yield* clone("alchemy-static-site-azure-local-docs-");
        const appCwd = yield* clone("alchemy-static-site-azure-local-app-");
        const program = Effect.gen(function* () {
          const docs = yield* Azure.Website.StaticSite("Docs", {
            cwd: docsCwd,
            command: "node build.mjs",
            outdir: "public",
            errorPage: "404.html",
          });
          const app = yield* Azure.Website.StaticSite("App", {
            cwd: appCwd,
            command: "node build.mjs",
            outdir: "public",
            spa: true,
          });
          return { docs, app };
        });

        const { docs, app } = yield* stack.deploy(program);
        for (const site of [docs, app]) {
          expect(site.url as string).toMatch(localUrl);
          expectNoCloudResources(site);
        }
        const docsUrl = (docs.url as string).replace(/\/$/, "");
        const appUrl = (app.url as string).replace(/\/$/, "");

        // The build ran: the server answers from outdir.
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${docsCwd}/public/index.html`)).toBe(true);
        const home = yield* waitForPage(`${docsUrl}/`, (page) => page.status === 200);
        expect(home.body).toContain("Azure static site fixture");
        const script = yield* fetchPage(`${docsUrl}/assets/app.js`);
        expect(script.status).toBe(200);
        expect(script.body).toContain('dataset.fixture = "static-site"');
        const missing = yield* fetchPage(`${docsUrl}/no-such-page`);
        expect(missing.status).toBe(404);
        expect(missing.body).toContain("page not found");

        // `spa: true` answers a deep link with the index page and a 200.
        const deepLink = yield* waitForPage(
          `${appUrl}/client/route`,
          (page) => page.status === 200,
        );
        expect(deepLink.body).toContain("Azure static site fixture");

        yield* stack.destroy();
        const gone = yield* fetchPage(`${docsUrl}/`).pipe(
          Effect.as("serving" as const),
          Effect.catch(() => Effect.succeed("stopped" as const)),
        );
        expect(gone).toBe("stopped");
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test.provider(
    "dev.command replaces the build with the external dev server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwd = yield* clone("alchemy-static-site-azure-local-dev-");
        const program = Effect.gen(function* () {
          return yield* Azure.Website.StaticSite("Site", {
            cwd,
            command: "node build.mjs",
            outdir: "public",
            dev: {
              command: "bun dev.mjs",
              env: { DEV_MARKER: "azure-static-site-dev-env" },
            },
          });
        });

        const site = yield* stack.deploy(program);
        expect(site.url as string).toMatch(localUrl);
        expectNoCloudResources(site);
        const url = (site.url as string).replace(/\/$/, "");

        // The build is skipped: the dev server serves src/ directly.
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${cwd}/public`)).toBe(false);
        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(home.body).toContain("Azure static site fixture");
        const env = yield* fetchPage(`${url}/__dev-env`);
        expect(JSON.parse(env.body)).toEqual({ marker: "azure-static-site-dev-env" });

        // A source edit shows up on the next request without a redeploy.
        const indexPath = `${cwd}/src/index.html`;
        const html = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(indexPath, html.replace("<body>", "<body><!-- DEV_EDIT -->"));
        const edited = yield* fetchPage(`${url}/`);
        expect(edited.body).toContain("DEV_EDIT");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  // ~$0.01/run (one Standard_LRS account); ~4 min.
  test.provider(
    "Alchemy.remote() deploys the site to Azure during dev",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwd = yield* clone("alchemy-static-site-azure-local-remote-");
        const program = Effect.gen(function* () {
          return yield* Azure.Website.StaticSite("Site", {
            cwd,
            command: "node build.mjs",
            outdir: "public",
            errorPage: "404.html",
            location: LOCATION,
            frontDoor: false,
            dev: { command: "bun dev.mjs" },
          });
        }).pipe(Alchemy.remote());

        const site = yield* stack.deploy(program);
        const url = site.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(site.frontDoor).toBeUndefined();
        const account = site.storageAccount!.storageAccountName;
        expect(account).not.toBe("devstoreaccount1");
        expect(site.storageAccount!.storageAccountId).toMatch(/^\/subscriptions\//);

        // Out of band: the files are in the real account's `$web` container.
        expect(yield* staticWebsiteEnabled(account)).toBe(true);
        const index = yield* webBlob(account, "index.html");
        expect(index?.contentType).toBe("text/html; charset=utf-8");
        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(home.body).toContain("Azure static site fixture");

        // Destroy deletes the live account (rows stamped `live`).
        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        expect(yield* getStorageAccount(groupName, account)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
