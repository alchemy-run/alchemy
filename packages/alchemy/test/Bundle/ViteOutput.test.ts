import { viteBuildOutputPlugin } from "@/Bundle/Vite";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

/** The subset of a Vite build environment the output plugin reads. */
const environment = (name: string, outDir: string) => ({
  name,
  config: { root: "/project", base: "/", build: { outDir } },
});

/** One entry chunk, as an environment hands it to `writeBundle`. */
const entryChunk = (fileName: string) => ({
  [fileName]: {
    type: "chunk" as const,
    isEntry: true,
    fileName,
    code: "export default { fetch() {} }",
    imports: [] as Array<string>,
  },
});

const writeBundle = (
  plugin: { writeBundle?: unknown },
  env: ReturnType<typeof environment>,
  bundle: Record<string, unknown>,
) =>
  Effect.promise(async () => {
    const hook = plugin.writeBundle;
    if (typeof hook !== "function") {
      throw new Error("writeBundle is not a function");
    }
    await hook.call(
      { environment: env, getModuleIds: () => [] as Array<string> },
      {},
      bundle,
    );
  });

describe("viteBuildOutputPlugin", () => {
  it("deploys the entry environment's bundle as the Worker", () =>
    Effect.gen(function* () {
      const output = yield* viteBuildOutputPlugin({ entryEnvironment: "ssr" });

      yield* writeBundle(output.plugin, environment("client", "dist/client"), {
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: "<!-->",
        },
      });
      yield* writeBundle(
        output.plugin,
        environment("ssr", "dist/ssr"),
        entryChunk("worker.js"),
      );

      const result = yield* output.output;
      const bundle = yield* result.serverBundle;

      expect(result.clientDirectory).toBe("/project/dist/client");
      expect(bundle?.files[0]?.path).toBe("dist/ssr/worker.js");
    }));

  // A project whose server build is not a Worker entry — a static-site
  // generator that renders pages during the build — still emits an entry
  // chunk, and deploying it produces a Worker that exports no handler and
  // answers nothing. `assetsOnly` leaves that output out of the deployment
  // while the client build, generated pages included, still ships.
  it("ignores server output when the deployment is assets-only", () =>
    Effect.gen(function* () {
      const output = yield* viteBuildOutputPlugin({
        entryEnvironment: "ssr",
        assetsOnly: true,
      });

      yield* writeBundle(output.plugin, environment("client", "dist/client"), {
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: "<!-->",
        },
      });
      yield* writeBundle(
        output.plugin,
        environment("ssr", "dist/ssr"),
        entryChunk("entry.server.js"),
      );

      const result = yield* output.output;

      expect(result.clientDirectory).toBe("/project/dist/client");
      expect(yield* result.serverBundle).toBeUndefined();
    }));
});
