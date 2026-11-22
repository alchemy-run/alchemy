import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { EnvironmentOptions } from "vite";
import { describe, expect, it } from "vitest";
import { AZURE_SERVE_ENTRY_FILE_NAME } from "../../core/AzureServe.ts";
import {
  bundleReactPlugin,
  makeAzureEntrySource,
  makeAzureTarget,
  SERVE_ENTRY_NAME,
  target,
} from "../azure.ts";

const configure = (name: string, external: string[]) => {
  const config: EnvironmentOptions = { resolve: { external: [...external] } };
  const hook = bundleReactPlugin().configEnvironment as (
    name: string,
    config: EnvironmentOptions,
  ) => void;
  hook(name, config);
  return config.resolve?.external;
};

describe("vinext azure target", () => {
  it("is the azure platform and its own module contract", () => {
    const azure = makeAzureTarget();
    expect(azure.platform).toBe("azure");
    expect(azure.build).toBeTypeOf("function");
    expect(target).toBe(makeAzureTarget);
    expect(SERVE_ENTRY_NAME).toBe(`server/${AZURE_SERVE_ENTRY_FILE_NAME}`);
  });

  it("wraps the App Router handler in a Fetch entry with no listener", () => {
    const source = makeAzureEntrySource();
    expect(source).toContain('import rsc from "./index.js"');
    expect(source).toContain("export default {");
    expect(source).toContain("x-forwarded-host");
    expect(source).not.toContain("listen(");
    expect(source).not.toContain("startProdServer");
  });

  it("bundles React into the server environments and keeps other externals", () => {
    const external = ["react", "react-dom", "react-dom/server", "ipaddr.js", "sharp"];
    expect(configure("ssr", external)).toEqual(["ipaddr.js", "sharp"]);
    expect(configure("rsc", external)).toEqual(["ipaddr.js", "sharp"]);
    expect(configure("client", external)).toEqual(external);
  });

  it(
    "builds the example into a Fetch entry that renders once bundled alone",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* path.fromFileUrl(
              new URL("../../../../../examples/azure-website-vinext/", import.meta.url),
            );
            const built = yield* makeAzureTarget().build!({ root, framework: "vinext" });
            expect(built.serverModules?.map((module) => module.name)).toEqual([SERVE_ENTRY_NAME]);
            // React is bundled: the SSR environment leaves no package external.
            const externals = yield* fs.readFileString(
              path.join(built.distDirectory!, "server/vinext-externals.json"),
            );
            expect(JSON.parse(externals)).toEqual([]);
            // Bundle the entry the way Azure.Functions.Function does, then run it
            // from a directory with no node_modules.
            const out = yield* fs.makeTempDirectoryScoped({ prefix: "vinext-azure-bundle-" });
            const { rolldown } = yield* Effect.promise(() => import("rolldown"));
            const bundle = yield* Effect.promise(() =>
              rolldown({
                input: path.join(built.distDirectory!, SERVE_ENTRY_NAME),
                platform: "node",
                resolve: { conditionNames: ["node", "module", "default"] },
              }),
            );
            yield* Effect.promise(() =>
              bundle.write({ dir: out, format: "esm", entryFileNames: "index.mjs" }),
            );
            const module = (yield* Effect.promise(() => import(path.join(out, "index.mjs")))) as {
              default: { fetch(request: Request): Promise<Response> };
            };
            const response = yield* Effect.promise(() =>
              module.default.fetch(new Request("https://app.azurewebsites.net/api/hello?name=x")),
            );
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.json())).toEqual({
              name: "x",
              greeting: "hello",
            });
            const page = yield* Effect.promise(() =>
              module.default.fetch(new Request("https://app.azurewebsites.net/")),
            );
            expect(page.status).toBe(200);
            expect(yield* Effect.promise(() => page.text())).toContain(
              "Hello from vinext on Azure!",
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      ),
    600_000,
  );
});
