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

describe("Azure.Website.Waku local", { tags }, () => {
  test.provider(
    "alchemy dev runs Waku's own dev server with no Azure resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixture("waku-app"), {
          prefix: "alchemy-waku-azure-local-",
          tempRoot,
          entries: [".gitignore", "package.json", "tsconfig.json", "src", "public"],
        });
        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Website.Waku("Web", {
              rootDir,
              env: { GREETING: "Hello from the Waku dev server" },
            });
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

        // `env` reaches the dev server, which renders the dynamic page.
        const home = yield* waitForPage(`${url}/`, (page) => page.status === 200, {
          times: 40,
        });
        expect(home.body).toContain("WAKU_AZURE_PAGE_MARKER");
        expect(home.body).toContain("Hello from the Waku dev server");

        const echo = yield* waitForPage(`${url}/echo?echo=dev`, (page) => page.status === 200);
        expect(echo.headers["x-rendered-by"]).toBe("waku-function");
        expect(JSON.parse(echo.body)).toMatchObject({
          marker: "WAKU_AZURE_API_MARKER",
          echo: "dev",
        });

        // HMR: the dev server serves an edited route without a redeploy.
        const echoPath = path.join(rootDir, "src/pages/_api/echo.ts");
        const source = yield* fs.readFileString(echoPath);
        yield* fs.writeFileString(
          echoPath,
          source.replaceAll("WAKU_AZURE_API_MARKER", "WAKU_AZURE_API_MARKER_V2"),
        );
        const reloaded = yield* waitForPage(`${url}/echo?echo=hmr`, (page) =>
          page.body.includes("WAKU_AZURE_API_MARKER_V2"),
        );
        expect(JSON.parse(reloaded.body)).toMatchObject({ echo: "hmr" });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
