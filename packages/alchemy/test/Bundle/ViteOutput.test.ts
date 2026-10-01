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

  it.effect("produces no server bundle for a client-only build", () =>
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

      expect(yield* result.serverBundle).toBeUndefined();
    }),
  );
});
