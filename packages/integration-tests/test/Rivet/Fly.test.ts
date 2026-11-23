import * as Fly from "@alchemy.run/fly";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetFly from "@alchemy.run/rivet/Fly";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { ClassSecretConfig } from "./fixtures/class-secret.ts";
import { controlPlaneToken, deployed, expectNoSecrets } from "./fixtures/deployed.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { Cluster } from "./fixtures/fly/cluster.ts";
import { CounterLive } from "./fixtures/fly/counter-live.ts";
import Front from "./fixtures/fly/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(Fly.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetFlyConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own: Fly builds its crate's image.
const RustPool = RivetFly.MachinePool("Rust").pipe(Layer.provide(Cluster));
/** Out-of-band reads run with the Fly credentials the stack deploys with. */
const fly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane of Fly Machines and a pool on a Fly Service, called from a Fly Service.
describe.skipIf(!!process.env.FAST)(
  "Rivet on Fly (Machines control plane, Fly Service pool)",
  { tags: ["provider:rivet", "provider:fly", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            const actors = yield* RustActors().pipe(Effect.provide(RustPool));
            return { url: front.url, rust: rustTarget(actors) };
          }).pipe(Effect.provide(CounterLive.pipe(Layer.provide(ClassSecretConfig)))),
        );
        const url = out.url;
        rust = out.rust as typeof rust;
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 900_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "live" });
    test(
      "Durable Streams: the front appends to and reads a stream on its cloud's Services pool",
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );

    test(
      "every node and Services Machine reads the token and the class's secret from App secrets, never its Machine config",
      fly(
        Effect.gen(function* () {
          const token = yield* controlPlaneToken(sharedStack);
          // The pools' nodes (the counter's, which reads a secret, and the
          // Rust one): Fly Services, each in an App of its own.
          const nodes = yield* deployed(sharedStack, "Fly.Service", /(Default|Rust)Nodes$/);
          expect(nodes).toHaveLength(2);
          // Rivet Services: Machines in the pool's App.
          const services = yield* deployed(sharedStack, "Fly.Machine", /ServicesNodes$/);
          expect(services).toHaveLength(1);
          for (const { attr } of [...nodes, ...services]) {
            const app = attr.appName as string;
            const listed = yield* machines.listMachines({ app_name: app });
            expect(listed.length).toBeGreaterThan(0);
            for (const machine of listed) {
              expect(machine.config?.env?.RIVET_TOKEN).toBeUndefined();
              expectNoSecrets(machine.config, token);
            }
            // The token is an App secret instead.
            const { secrets } = yield* machines.listSecrets({ app_name: app, show_secrets: false });
            expect((secrets ?? []).some((secret) => secret.name?.endsWith("RIVET_TOKEN"))).toBe(
              true,
            );
          }
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "the engines read the admin token and the bucket's secret key from App secrets, never their Machine config",
      fly(
        Effect.gen(function* () {
          const token = yield* controlPlaneToken(sharedStack);
          const engines = yield* deployed(sharedStack, "Fly.Machine", /RivetEngine\d+$/);
          expect(engines.length).toBeGreaterThan(0);
          const app = engines[0]!.attr.appName as string;
          for (const machine of yield* machines.listMachines({ app_name: app })) {
            const env = Object.keys(machine.config?.env ?? {});
            expect(env).not.toContain("RIVET__AUTH__ADMIN_TOKEN");
            expect(env).not.toContain("RIVET__OBJECT_STORAGE__PRIMARY__S3__SECRET_ACCESS_KEY");
            expectNoSecrets(machine.config, token);
          }
          const { secrets } = yield* machines.listSecrets({ app_name: app, show_secrets: false });
          expect((secrets ?? []).map((secret) => secret.name).sort()).toEqual(
            expect.arrayContaining([
              "RIVET__AUTH__ADMIN_TOKEN",
              "RIVET__OBJECT_STORAGE__PRIMARY__S3__SECRET_ACCESS_KEY",
            ]),
          );
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "a Rust Durable Object runs on a Fly Service pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "fly-rust");
      }),
      { timeout: 300_000 },
    );
  },
);
