import { layerRuntime } from "@distilled.cloud/cloudflare-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeV8 from "node:v8";
import {
  Artifacts,
  createArtifactStore,
  makeScopedArtifacts,
} from "../../Artifacts.ts";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import * as Credentials from "../Credentials.ts";
import * as RpcServerEnvironment from "../../Local/RpcServerEnvironment.ts";
import { PlatformServices, runMain } from "../../Util/PlatformServices.ts";
import { materializeRuntimeBindings } from "./RuntimeBindings.ts";
import { loadSource, SourceProviderError } from "./Source.ts";
import * as Vite from "./Sources/Vite.ts";
import {
  DEFAULT_DEV_PORT,
  type ViteChildConfig,
  VITE_CHILD_READY_PREFIX,
  VITE_CHILD_READY_SUFFIX,
} from "./ViteChild.shared.ts";

const readConfig = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const chunks = yield* Stream.runCollect(stdio.stdin);
  return NodeV8.deserialize(Buffer.concat(chunks)) as ViteChildConfig;
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* readConfig;
    const credentials = Credentials.fromAuthProvider().pipe(
      Layer.provide(CloudflareAuth),
    );
    const runtimeContext = yield* layerRuntime({
      api: { accountId: config.accountId },
      storage: { directory: config.storageDirectory },
    }).pipe(
      Layer.provide(Layer.mergeAll(credentials, FetchHttpClient.layer)),
      Layer.build,
    );
    // The non-runtime fields are consumed here; everything else in
    // `config.worker` is the runtime worker shape `viteDev` expects, so new
    // runtime fields flow through without being re-listed.
    const {
      compatibility,
      main,
      viteEnvironments,
      hasAssets,
      bindingDescriptors,
      devRemote,
      ...runtimeWorker
    } = config.worker;
    const bindings = yield* materializeRuntimeBindings(
      {
        name: config.worker.name,
        env: config.env,
        hasAssets,
        bindingDescriptors,
        devRemote,
      },
      {
        accountId: config.accountId,
        selfUrl: config.publicUrl,
        stack: config.stack,
      },
    );
    const source = config.source;
    const url = source
      ? yield* loadSource(source.descriptor).pipe(
          // `loadSource` is typed against the full `SourceServices` union
          // (which includes the per-run Artifacts cache the live provider
          // supplies); the dev child has no run-scoped cache, so hand the
          // module a fresh one.
          Effect.provideService(
            Artifacts,
            makeScopedArtifacts(createArtifactStore(), source.id),
          ),
          Effect.flatMap((provider) =>
            provider.dev({
              id: source.id,
              workerName: config.worker.name,
              compatibility,
              entry: { kind: "external" },
              stack: config.stack,
              env: config.env,
              extraOptions: undefined,
              assets: source.assets,
              worker: {
                bindings,
                durableObjectNamespaces: config.worker.durableObjectNamespaces,
                hyperdrives: config.worker.hyperdrives,
                queueConsumers: Effect.succeed(config.worker.queueConsumers),
                assets: config.worker.assets,
              },
              runtimeContext,
            }),
          ),
          Effect.flatMap((handle) =>
            handle.mode === "server"
              ? Effect.succeed(handle.url.toString())
              : Effect.fail(
                  new SourceProviderError({
                    provider: source.descriptor.provider,
                    message:
                      "A source declared devMode 'server' but returned a bundle-mode dev handle.",
                  }),
                ),
          ),
        )
      : yield* Vite.viteDev(
          config.rootDir,
          config.env,
          {
            main,
            compatibilityDate: compatibility.date,
            compatibilityFlags: compatibility.flags,
            viteEnvironments,
            worker: { ...runtimeWorker, bindings },
            context: runtimeContext,
          },
          {
            // Match Alchemy's local Worker port range. The stable Alchemy proxy
            // normally occupies the first port in the range, so the internal
            // Vite server must be allowed to advance.
            port: DEFAULT_DEV_PORT,
            strictPort: false,
          },
        ).pipe(Effect.map((server) => server.resolvedUrls?.local[0]));
    if (!url) {
      return yield* Effect.die("Dev server child started without a local URL");
    }
    yield* Effect.sync(() => {
      process.stdout.write(
        `${VITE_CHILD_READY_PREFIX}${url}${VITE_CHILD_READY_SUFFIX}\n`,
      );
    });
    return yield* Effect.never;
  }),
);

runMain(
  program.pipe(
    Effect.provide(RpcServerEnvironment.fromEnv()),
    Effect.provide(PlatformServices),
  ),
);
