/**
 * Hosted dashboard: the deploy-time credential derivation the Cloudflare
 * factory performs, and the Worker entry's bundle — the runtime module must
 * build with the standard Effect-native entry (no filesystem or
 * credential-store code may leak into it).
 *
 * No cloud: credentials come from a temp `ALCHEMY_HOME`, the bundle is
 * built locally.
 */
import { CredentialsStore, CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileStoreLive } from "@/Auth/Profile.ts";
import {
  CREDENTIALS_FILE,
  StoredStateStoreCredentials,
} from "@/Cloudflare/StateStore/CredentialsFile.ts";
import { WorkerBundle } from "@/Cloudflare/Workers/Sources/Rolldown";
import {
  DashboardStateStoreNotFound,
  resolveCloudflareStateStore,
} from "@/Dashboard/Hosted/Cloudflare.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { fileURLToPath } from "node:url";
import * as TestCore from "../../src/Test/Core";
import { TestLayers } from "../test.resources";

const decode = (content: string | Uint8Array<ArrayBufferLike>) =>
  typeof content === "string"
    ? content
    : new TextDecoder().decode(content as Uint8Array);

/** Run with an isolated `~/.alchemy` so no real profile is read or written. */
const withTempHome = <A>(body: Effect.Effect<A, any, any>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectory({ prefix: "alchemy-home-" });
    const previous = process.env.ALCHEMY_HOME;
    process.env.ALCHEMY_HOME = home;
    return yield* body.pipe(
      // the stores resolve ALCHEMY_HOME lazily — build them inside the override
      Effect.provide(Layer.mergeAll(ProfileStoreLive, CredentialsStoreLive)),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.ALCHEMY_HOME;
          } else {
            process.env.ALCHEMY_HOME = previous;
          }
        }),
      ),
    );
  });

describe("hosted dashboard (Cloudflare)", () => {
  test(
    "derives the state store from the profile's cached credentials",
    () =>
      TestCore.run(
        withTempHome(
          Effect.gen(function* () {
            // nothing cached yet: a user-facing error naming the fix
            const missing = yield* Effect.result(resolveCloudflareStateStore);
            expect(Result.isFailure(missing)).toBe(true);
            if (Result.isFailure(missing)) {
              expect(missing.failure).toBeInstanceOf(
                DashboardStateStoreNotFound,
              );
              expect(missing.failure.message).toContain("Cloudflare.state()");
            }

            // what Cloudflare.state() caches after a deploy
            const store = yield* CredentialsStore;
            yield* store.write(
              "default",
              CREDENTIALS_FILE,
              StoredStateStoreCredentials,
              {
                url: "https://alchemy-state-store.example.workers.dev",
                authToken: "token-123",
                accountId: "acc-1",
              },
            );
            const target = yield* resolveCloudflareStateStore;
            expect(target).toEqual({
              url: "https://alchemy-state-store.example.workers.dev",
              authToken: "token-123",
            });
          }),
        ),
        { providers: TestLayers() },
      ),
    { exclusive: true, timeout: 30_000 },
  );
});

layer(NodeServices.layer)("hosted dashboard worker bundle", (it) => {
  it.effect(
    "the Cloudflare entry bundles as an Effect-native Worker",
    () =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "alchemy-dashboard-bundle-test",
          main: fileURLToPath(
            import.meta
              .resolve("../../src/Dashboard/Hosted/CloudflareDashboardWorker.ts"),
          ),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "effect", exports: {} },
          stack: { name: "hosted-dashboard-test", stage: "test" },
          extraOptions: undefined,
        });
        const code = output.files
          .map((file) => decode(file.content))
          .join("\n");
        // the Worker class and its SPA routing survive the bundle
        expect(code).toContain("AlchemyDashboard");
        expect(code).toContain("single-page-application");
        // deploy-time-only code never reaches the bundle
        expect(code).not.toContain("cloudflare-state-store.json");
      }),
    { timeout: 180_000 },
  );
});
