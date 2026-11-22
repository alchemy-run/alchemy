import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import { AZURE_SERVE_ENTRY_FILE_NAME } from "../../core/AzureServe.ts";
import { isDeployTarget } from "../../core/index.ts";
import { NODE_SERVE_ENTRY_FILE_NAME } from "../../core/NodeServe.ts";
import { SERVER_ENTRY_FILE_NAME, target } from "../azure.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E>,
  );

describe("TanStack Start azure target", () => {
  it("reuses the Node build under the azure platform", () => {
    const azure = target({ outDir: "build" });
    expect(isDeployTarget(azure)).toBe(true);
    expect(azure.platform).toBe("azure");
    expect(azure.serverEntryFileName).toBe(SERVER_ENTRY_FILE_NAME);
    expect(azure.config.outDir).toBe("build");
    expect(azure.build).toBeTypeOf("function");
    expect(azure.finish).toBeTypeOf("function");
  });

  it("finishes with a Fetch entry around the server entry instead of a listener", async () => {
    const result = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tanstack-start-azure-finish-" });
        const serverDir = path.join(dir, "server");
        const clientDir = path.join(dir, "client");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, SERVER_ENTRY_FILE_NAME),
          "export default { fetch: (request) => new Response(new URL(request.url).host) };",
        );
        const output = yield* target().finish!(
          {
            distDirectory: dir,
            clientDirectory: clientDir,
            serverModules: [],
            externalWorkspaces: new Set<string>(),
          },
          {
            root: dir,
            framework: "tanstack-start",
            entry: path.join(serverDir, SERVER_ENTRY_FILE_NAME),
          },
        );
        const entryPath = path.join(dir, output.serverModules![0]!.name);
        const module = (yield* Effect.promise(() => import(entryPath))) as {
          default: { fetch(request: Request): Promise<Response> };
        };
        const response = yield* Effect.promise(() =>
          module.default.fetch(
            new Request("https://app.azurewebsites.net/page", {
              headers: { "x-forwarded-host": "site.z01.azurefd.net" },
            }),
          ),
        );
        return {
          names: output.serverModules!.map((item) => item.name),
          listener: yield* fs.exists(path.join(serverDir, NODE_SERVE_ENTRY_FILE_NAME)),
          body: yield* Effect.promise(() => response.text()),
        };
      }),
    );
    expect(result.names[0]).toBe(`server/${AZURE_SERVE_ENTRY_FILE_NAME}`);
    expect(result.names).not.toContain(`server/${NODE_SERVE_ENTRY_FILE_NAME}`);
    expect(result.listener).toBe(false);
    // The framework sees the viewer's host from Front Door.
    expect(result.body).toBe("site.z01.azurefd.net");
  });
});
