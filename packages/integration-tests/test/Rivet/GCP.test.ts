import * as GCP from "@alchemy.run/gcp";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { secretMembers, workerPools } from "./fixtures/gcp-checks.ts";
import { Cluster } from "./fixtures/gcp/cluster.ts";
import { CounterLive } from "./fixtures/gcp/counter-live.ts";
import Front from "./fixtures/gcp/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(GCP.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetGcpConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own, reading a secret of the
// stack's besides the control plane's token, and run as a service account
// of the stack's own when `named` is set.
const program = (named: boolean) =>
  Effect.gen(function* () {
    const front = yield* Front;
    const extra = yield* SecretManager.Secret("RustExtra", { value: "extra-value" });
    const account = named
      ? (yield* IAM.ServiceAccount("RustNodes", { displayName: "Rivet Rust nodes" })).email
      : undefined;
    const actors = yield* RustActors().pipe(
      Effect.provide(
        RivetGCP.CloudRunPool("Rust", {
          secrets: { EXTRA_SECRET: extra.version.pipe(Output.map((v) => v ?? "")) },
          ...(account === undefined ? {} : { serviceAccount: account }),
        }).pipe(Layer.provide(Cluster)),
      ),
    );
    return { url: front.uri, rust: rustTarget(actors), extra: extra.name, account };
  }).pipe(Effect.provide(CounterLive));
const accessor = "roles/secretmanager.secretAccessor";
/** Out-of-band reads run with the GCP credentials and project the stack deploys with. */
const gcp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);
// Tests that redeploy the Rust pool, or call it, never overlap.
const rustPool = { exclusive: "rivet-gcp-run-rust" } as const;

/** The Rust pool's nodes: the account they run as and their env. */
const rustNodes = Effect.fn(function* () {
  const [pool] = yield* workerPools(sharedStack, /rustnodes$/);
  expect(pool).toBeDefined();
  return {
    account: pool!.template?.serviceAccount ?? "",
    env: pool!.template?.containers?.[0]?.env ?? [],
  };
});
const secretOf = (
  env: ReadonlyArray<{ name?: string; valueSource?: { secretKeyRef?: { secret?: string } } }>,
  name: string,
) => env.find((entry) => entry.name === name)?.valueSource?.secretKeyRef?.secret ?? "";

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on Compute Engine and a Cloud Run worker pool, called from Cloud Run.
describe.skipIf(!!process.env.FAST)(
  "Rivet on GCP (Compute control plane, Cloud Run worker pool)",
  { tags: ["provider:rivet", "provider:gcp", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(program(false));
        const url = out.url;
        rust = out.rust as RustTarget;
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 900_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "live" });

    test(
      "a Rust Durable Object runs on a Cloud Run worker pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "gcp-rust");
      }),
      { timeout: 300_000, ...rustPool },
    );

    test(
      "the token and the pool's secrets reach the nodes by reference, granted to the worker pool's account",
      gcp(
        Effect.gen(function* () {
          const { account, env } = yield* rustNodes();
          // Neither value is in the worker pool's configuration.
          for (const name of ["RIVET_TOKEN", "EXTRA_SECRET"]) {
            const entry = env.find((e) => e.name === name);
            expect(entry?.value).toBeUndefined();
            expect(yield* secretMembers(secretOf(env, name), accessor)).toContain(
              `serviceAccount:${account}`,
            );
          }
        }),
      ),
      { timeout: 120_000, ...rustPool },
    );

    test(
      "a named service account runs the nodes and is granted every secret",
      gcp(
        Effect.gen(function* () {
          const out = yield* sharedStack.deploy(program(true));
          rust = out.rust as RustTarget;
          const { account, env } = yield* rustNodes();
          expect(account).toBe(out.account);
          for (const name of ["RIVET_TOKEN", "EXTRA_SECRET"]) {
            expect(yield* secretMembers(secretOf(env, name), accessor)).toContain(
              `serviceAccount:${out.account}`,
            );
          }
          yield* expectRustCounter(rust, "gcp-rust-named");
        }),
      ),
      { timeout: 600_000, ...rustPool },
    );
  },
);
