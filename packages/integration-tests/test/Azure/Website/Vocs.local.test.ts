import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { fixture, logLevel, tempRoot, waitForPage } from "./site.ts";

// `dev: true` runs the local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

const tags = ["provider:azure", "provider:azure:website", "local"];

/** A dev server's own address: `http://localhost:<port>` or `http://127.0.0.1:<port>`. */
const localUrl = /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\]):\d+\/?$/;

describe("Azure.Website.Vocs local", { tags }, () => {
  test.provider(
    "alchemy dev runs Vocs' own dev server with no Azure resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixture("vocs-app"), {
          prefix: "alchemy-vocs-azure-local-",
          tempRoot,
          entries: [
            ".gitignore",
            "package.json",
            "tsconfig.json",
            "vocs.config.ts",
            "src",
            "public",
          ],
        });
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Vocs("Docs", { rootDir });
          }),
        );

        // The framework's dev server: a local URL and no Azure resource.
        const url = (site.url as string).replace(/\/$/, "");
        expect(site.url as string).toMatch(localUrl);
        expect(site.resourceGroup).toBeUndefined();
        expect(site.storageAccount).toBeUndefined();
        expect(site.assets).toBeUndefined();
        expect(site.server).toBeUndefined();
        expect(site.frontDoor).toBeUndefined();

        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200, {
          times: 40,
        });
        expect(home.body).toContain("VOCS_AZURE_PAGE_MARKER");
        const hello = yield* waitForPage(`${url}/hello.txt`, (page) => page.status === 200);
        expect(hello.body).toContain("vocs-azure-public-marker");

        // HMR: the dev server serves an edited page without a redeploy.
        const guidePath = path.join(rootDir, "src/pages/guide.mdx");
        const source = yield* fs.readFileString(guidePath);
        yield* fs.writeFileString(
          guidePath,
          source.replace("VOCS_AZURE_GUIDE_MARKER", "VOCS_AZURE_GUIDE_MARKER_V2"),
        );
        const guide = yield* waitForPage(`${url}/guide`, (page) =>
          page.body.includes("VOCS_AZURE_GUIDE_MARKER_V2"),
        );
        expect(guide.status).toBe(200);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
