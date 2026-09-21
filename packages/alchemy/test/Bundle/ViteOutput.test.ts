import { viteBuildOutputPlugin } from "@/Bundle/Vite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
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

layer(NodeServices.layer)("viteBuildOutputPlugin", (it) => {
  it.effect("deploys the entry environment's bundle as the Worker", () =>
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
    }),
  );

  // A framework can leave a description of its build beside the server
  // bundle (Foldkit's `foldkit.build.json`), so whoever deploys it needs to
  // know where that is — the entry environment's own output directory.
  it.effect("reports the entry environment's output directory", () =>
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
        environment("ssr", "dist/server"),
        entryChunk("fetch.js"),
      );

      const result = yield* output.output;

      expect(result.serverDirectory).toBe("/project/dist/server");
    }),
  );

  it.effect("reports no server directory for a client-only build", () =>
    Effect.gen(function* () {
      const output = yield* viteBuildOutputPlugin({ entryEnvironment: "ssr" });

      yield* writeBundle(output.plugin, environment("client", "dist/client"), {
        "index.html": {
          type: "asset",
          fileName: "index.html",
          source: "<!-->",
        },
      });

      const result = yield* output.output;

      expect(result.serverDirectory).toBeUndefined();
      expect(yield* result.serverBundle).toBeUndefined();
    }),
  );
});
