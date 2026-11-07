import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { CALLER_CA, PROVIDER_CA } from "../../Local/fixtures/test-cas.ts";
import { cloneFixture } from "../Utils/Fixture.ts";

// In-process: the Vite child takes its environment from the process that
// starts it, and the sidecar's is fixed when it spawns.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: false,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "vite-trust-fixture");
// Under the workspace, as the other Vite fixtures (see Vite.test.ts).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

/** Runs `use` with these variables set on the process. */
const withEnv = <A, E, R>(variables: Record<string, string>, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        Object.keys(variables).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, variables);
      return previous;
    }),
    () => use,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

test.provider(
  "Vite dev: the dev server's Node process trusts the caller's CA and every provider's",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const certificates = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-vite-trust-" });
      const caller = pathe.join(certificates, "caller.pem");
      const contributed = pathe.join(certificates, "contributed.pem");
      yield* fs.writeFileString(caller, CALLER_CA);
      yield* fs.writeFileString(contributed, PROVIDER_CA);
      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-trust-",
        tempRoot,
        entries: ["package.json", "vite.config.ts", "src"],
      });

      const site = yield* withEnv(
        { NODE_EXTRA_CA_CERTS: caller, ALCHEMY_DEV_TRUST: contributed },
        stack.deploy(
          Cloudflare.Website.Vite("ViteTrust", {
            rootDir,
            main: "./src/index.ts",
            workersDev: true,
            compatibility: { date: "2024-12-30" },
            memo: { include: ["**/*"] },
            dev: { port: 0 },
          }),
        ),
      );

      const seen = yield* Effect.tryPromise(async () => {
        const response = await fetch(`${site.url!.replace(/\/$/, "")}/__node-trust`);
        return (await response.json()) as { bundle?: string; certificates?: string };
      }).pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("1 second") }));
      expect(seen.bundle).not.toBe(caller);
      expect(seen.certificates).toContain(CALLER_CA.trim());
      expect(seen.certificates).toContain(PROVIDER_CA.trim());
    }).pipe(Effect.scoped, Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
  // Sets process-global environment variables.
  { tags: ["provider:cloudflare:worker", "local"], timeout: 180_000, exclusive: true },
);
