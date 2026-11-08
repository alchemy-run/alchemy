import * as crypto from "node:crypto";
import {
  makeSourceContext,
  resolveSource,
  SourceProviderError,
  type SourceContext,
} from "@alchemy.run/cloudflare/Workers/Source";
import type { WorkerProps } from "@alchemy.run/cloudflare/Workers/Worker";
import { sourceHashProps } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { describe, expect, it } from "@alchemy.run/test";
import { NodeServices } from "@effect/platform-node";
import { Artifacts, createArtifactStore, makeScopedArtifacts } from "alchemy/Artifacts";
import { stripEffects } from "alchemy/Diff";
import * as Effect from "effect/Effect";

const providerModule = new URL("./fixtures/source-provider/provider.ts", import.meta.url).href;
const invalidModule = new URL("./fixtures/source-provider/invalid.ts", import.meta.url).href;
const buildPluginWorker = new URL("./fixtures/build-plugin/worker.mjs", import.meta.url).href;

const ctx = (props: WorkerProps): SourceContext =>
  makeSourceContext({
    id: "TestWorker",
    fqn: "TestWorker",
    workerName: "stack-testworker-dev-abc123",
    props,
    compatibility: { date: "2024-01-01", flags: [] },
    stack: { name: "stack", stage: "dev" },
  });

const provide = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof resolveSource>> | Artifacts>,
) =>
  effect.pipe(
    Effect.provideService(Artifacts, makeScopedArtifacts(createArtifactStore(), "test")),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  );

describe(
  "resolveSource",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  () => {
    it.effect("maps props.script to the inline-script source", () =>
      provide(
        Effect.gen(function* () {
          const script = "export default { fetch: () => new Response('hi') };";
          const props: WorkerProps = { script };
          const source = yield* resolveSource(props);
          expect(source.ownsAssets).toBe(false);
          const slots = yield* source.hash(ctx(props), undefined);
          expect(slots.bundle).toBe(crypto.createHash("sha256").update(script).digest("hex"));
          const out = yield* source.build(ctx(props));
          expect(out.bundle?.files[0].path).toBe("main.js");
          expect(out.bundle?.hash).toBe(slots.bundle);
          expect(out.assets).toBeUndefined();
        }),
      ),
    );

    it.effect(
      "hashes a redeploy's bundle with the build plugins the diff's stripEffects drops",
      () =>
        Effect.gen(function* () {
          const props: WorkerProps = {
            main: buildPluginWorker,
            build: {
              input: {
                plugins: [
                  {
                    name: "answer",
                    resolveId: { filter: { id: /^virtual:answer$/ }, handler: (id) => `\0${id}` },
                    load: {
                      filter: { id: /^\0virtual:answer$/ },
                      handler: () => "export default 42;",
                    },
                  },
                ],
              },
            },
          };
          // Each deploy hashes with a fresh artifact store, as a redeploy's plan does.
          const hashFrom = (from: WorkerProps) =>
            provide(
              Effect.flatMap(resolveSource(from), (source) => source.hash(ctx(from), undefined)),
            );
          const built = yield* provide(
            Effect.flatMap(resolveSource(props), (source) => source.build(ctx(props))),
          );

          const stripped = stripEffects(props);
          const failed = yield* Effect.flip(hashFrom(stripped));
          expect(failed.message).toContain("[plugin answer]");

          const slots = yield* hashFrom(sourceHashProps(stripped, props));
          expect(slots.bundle).toBe(built.bundle?.hash);
        }),
    );

    it.effect("maps props.vite to the asset-owning vite source", () =>
      provide(
        Effect.gen(function* () {
          const source = yield* resolveSource({ vite: { rootDir: "." } });
          expect(source.ownsAssets).toBe(true);
        }),
      ),
    );

    it.effect("loads an external provider from a source descriptor", () =>
      provide(
        Effect.gen(function* () {
          const props: WorkerProps = {
            source: { provider: providerModule, devMode: "bundle", options: { marker: "abc-123" } },
          };
          const source = yield* resolveSource(props);
          const out = yield* source.build(ctx(props));
          expect(String(out.bundle?.files[0].content)).toContain("abc-123");
          const slots = yield* source.hash(ctx(props), undefined);
          expect(slots.bundle).toBe(out.bundle?.hash);
        }),
      ),
    );

    it.effect(
      "fails with SourceProviderError naming the package when the module cannot be imported",
      () =>
        provide(
          Effect.gen(function* () {
            const result = yield* Effect.result(
              resolveSource({
                source: { provider: "@alchemy.run/does-not-exist-fixture", devMode: "bundle" },
              }),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure).toBeInstanceOf(SourceProviderError);
              expect((result.failure as SourceProviderError).message).toContain(
                "@alchemy.run/does-not-exist-fixture",
              );
            }
          }),
        ),
    );

    it.effect("fails with SourceProviderError when the module's default export lacks make()", () =>
      provide(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            resolveSource({ source: { provider: invalidModule, devMode: "bundle" } }),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(SourceProviderError);
            expect((result.failure as SourceProviderError).message).toContain("WorkerSourceModule");
          }
        }),
      ),
    );

    it.effect("rejects source combined with main/script/vite", () =>
      provide(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            resolveSource({
              source: { provider: providerModule, devMode: "bundle" },
              main: "./worker.ts",
            }),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(SourceProviderError);
            expect((result.failure as SourceProviderError).message).toContain('"main"');
          }
        }),
      ),
    );
  },
);
