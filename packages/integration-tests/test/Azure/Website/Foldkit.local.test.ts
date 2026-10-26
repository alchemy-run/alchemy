import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { foldkitFixture, foldkitMemo } from "../../Website/Foldkit.ts";
import {
  assertGroupGone,
  fetchPage,
  getStorageAccount,
  LOCATION,
  logLevel,
  staticWebsiteEnabled,
  storageWebUrl,
  waitForPage,
  webBlob,
} from "./site.ts";

// `dev: true` runs the local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const tags = ["provider:azure", "provider:azure:website", "local"];

/** A dev server's own address: `http://localhost:<port>` or `http://127.0.0.1:<port>`. */
const localUrl = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/;

describe("Azure.Website.Foldkit local", { tags }, () => {
  test.provider(
    "alchemy dev runs Foldkit's Vite dev server with no Azure resources",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* foldkitFixture("ssr");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Foldkit("Web", { rootDir, output: "server" });
          }),
        );
        expect(site.url as string).toMatch(localUrl);
        expect(site.resourceGroup).toBeUndefined();
        expect(site.storageAccount).toBeUndefined();
        expect(site.assets).toBeUndefined();
        expect(site.server).toBeUndefined();
        expect(site.frontDoor).toBeUndefined();
        const url = (site.url as string).replace(/\/$/, "");

        // The dev server renders the page from the request's query.
        const home = yield* waitForPage(
          `${url}/?count=7`,
          (page) => page.status === 200 && /id="count"[^>]*>7</.test(page.body),
          { spacing: "2 seconds", times: 45 },
        );
        expect(home.body).toMatch(/id="count"[^>]*>7</);
        const probe = yield* fetchPage(`${url}/foldkit-probe.txt`);
        expect(probe.body).toBe("FOLDKIT_STATIC_ASSET");

        yield* stack.destroy();
        const gone = yield* fetchPage(`${url}/`).pipe(
          Effect.as("serving" as const),
          Effect.catch(() => Effect.succeed("stopped" as const)),
        );
        expect(gone).toBe("stopped");
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // ~$0.01/run (one Standard_LRS account); ~5 min. Without Front Door the
  // remote deploy stays off the 30-minute profile delete.
  test.provider(
    "Alchemy.remote() deploys the SPA to Azure during dev",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* foldkitFixture("spa");
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Foldkit("Web", {
              rootDir,
              location: LOCATION,
              frontDoor: false,
              memo: foldkitMemo,
            });
          }).pipe(Alchemy.remote()),
        );
        const url = site.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(site.server).toBeUndefined();
        const account = site.storageAccount!.storageAccountName;
        expect(site.storageAccount!.storageAccountId).toMatch(/^\/subscriptions\//);

        // Out of band: the client build is in the real account's `$web`.
        expect(yield* staticWebsiteEnabled(account)).toBe(true);
        const index = yield* webBlob(account, "index.html");
        expect(index?.contentType).toBe("text/html; charset=utf-8");
        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(home.body).toContain("Foldkit Fixture");

        // Destroy deletes the live account (rows stamped `live`).
        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        expect(yield* getStorageAccount(groupName, account)).toBeUndefined();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
