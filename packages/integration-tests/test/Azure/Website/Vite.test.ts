import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  assertGroupGone,
  cloudflareFixture,
  fetchPage,
  LOCATION,
  logLevel,
  storageWebUrl,
  tags,
  tempRoot,
  waitForPage,
} from "./site.ts";

const { test } = Test.make({ providers: Azure.providers() });

const fixtureDir = cloudflareFixture("vite-spa-fixture");
const fixtureEntries = ["index.html", "package.json", "src"];

describe("Azure.Website.Vite", { tags }, () => {
  test.provider(
    "Vite SPA: deploy to a storage static website, update, destroy, gone",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vite-azure-",
          tempRoot,
          entries: fixtureEntries,
        });
        const program = Effect.gen(function* () {
          return yield* Azure.Website.Vite("Web", {
            rootDir,
            location: LOCATION,
            memo: { include: ["index.html", "src/**", "package.json"] },
          });
        });

        const site = yield* stack.deploy(program);
        const url = site.url as string;
        expect(url).toMatch(storageWebUrl);
        expect(site.assets?.fileCount).toBeGreaterThan(0);

        const index = yield* waitForPage(`${url}/`, (page) => page.status === 200);
        expect(index.body).toContain("Vite SPA fixture");
        expect(index.type).toContain("text/html");
        const script = index.body.match(/<script[^>]+src="([^"]+)"/);
        expect(script).not.toBeNull();
        const javascript = yield* fetchPage(new URL(script![1]!, `${url}/`).href);
        expect(javascript.status).toBe(200);
        expect(javascript.type).toMatch(/javascript/);
        // SPA fallback: the shell, with the storage endpoint's 404 status.
        const fallback = yield* fetchPage(`${url}/missing-client-route`);
        expect(fallback.body).toContain("Vite SPA fixture");

        // Change one file: the redeploy uploads it and serves the new copy.
        const fs = yield* FileSystem.FileSystem;
        const indexPath = `${rootDir}/index.html`;
        const html = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          html.replace("<body>", "<body><!-- AZURE_REDEPLOY -->"),
        );
        const updated = yield* stack.deploy(program);
        expect(updated.url).toBe(url);
        expect(updated.assets?.contentHash).not.toBe(site.assets?.contentHash);
        yield* waitForPage(`${url}/`, (page) => page.body.includes("AZURE_REDEPLOY"));

        const groupName = site.resourceGroup!.resourceGroupName;
        yield* stack.destroy();
        yield* assertGroupGone(groupName);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
