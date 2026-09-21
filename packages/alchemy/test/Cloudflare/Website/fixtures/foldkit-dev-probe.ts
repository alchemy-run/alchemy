import { layerRuntime } from "@alchemy.run/cloudflare-runtime/core";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSource } from "../../../../src/Cloudflare/Workers/Source.ts";
import { Assets } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const mode = process.argv[2];
const program = Effect.gen(function* () {
  const runtimeContext = yield* layerRuntime({
    api: { accountId: "local-only" },
  }).pipe(
    Layer.provide(
      Credentials.fromApiToken({
        apiToken: "unused-local-only",
        apiBaseUrl: "http://127.0.0.1:1",
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.build,
  );
  // LocalWorkerProvider starts the Vite child in the app directory and
  // supplies its standard ASSETS binding for every props.vite Worker.
  const source = yield* resolveSource({
    vite: {
      framework: "foldkit",
      main: mode === "custom" ? "src/worker.ts" : undefined,
    },
  });
  const handle = yield* source.dev({
    id: "DevProbe",
    fqn: "DevProbe",
    workerName: "dev-probe",
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
    entry: { kind: "external" },
    stack: { name: "probe", stage: "test" },
    env: {},
    selfUrl: undefined,
    assets: undefined,
    extraOptions: undefined,
    worker: {
      bindings: [Assets.local("ASSETS")],
      durableObjectNamespaces: [],
      hyperdrives: {},
      queueConsumers: Effect.succeed([]),
      assets: undefined,
    },
    runtimeContext,
  });
  if (handle.mode !== "server") throw new Error("Expected a dev server");
  const response = yield* Effect.promise(() =>
    fetch(new URL(mode === "ssr" ? "/?count=7" : "/", handle.url)),
  );
  const html = yield* Effect.promise(() => response.text());
  if (
    response.status !== 200 ||
    !html.includes(mode === "ssr" ? ">7<" : "Foldkit Fixture")
  ) {
    throw new Error(`Unexpected dev response: ${response.status} ${html}`);
  }
  yield* Effect.log("foldkit-dev-ok");
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
