import * as Hetzner from "@alchemy.run/hetzner";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetHetzner from "@alchemy.run/rivet/Hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { ClassSecretConfig } from "./fixtures/class-secret.ts";
import { controlPlaneToken, deployed, expectNoSecrets } from "./fixtures/deployed.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { Cluster, SERVER_TYPE } from "./fixtures/hetzner/cluster.ts";
import { CounterLive } from "./fixtures/hetzner/counter-live.ts";
import Front from "./fixtures/hetzner/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(Hetzner.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetHetznerConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own.
const RustPool = RivetHetzner.ServerPool("Rust", { serverType: SERVER_TYPE }).pipe(
  Layer.provide(Cluster),
);

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane of Hetzner Servers and a pool of Hetzner Services, called from a Hetzner Service.
describe.skipIf(!!process.env.FAST)(
  "Rivet on Hetzner (Server control plane, Hetzner Service pool)",
  { tags: ["provider:rivet", "provider:hetzner", "live"] },
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
      "Durable Streams: the front appends to and reads a stream on its cloud's Services pool",
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );

    test(
      "no node's user data holds the token or the class's secret, and only root can read its env file",
      Effect.gen(function* () {
        const token = yield* controlPlaneToken(sharedStack);
        // The counter's pool (whose class reads a secret), the Rust pool, and
        // Rivet Services. Hetzner's API never returns user data, but every
        // process on a Server reads it from the metadata service: look there.
        const servers = yield* deployed(
          sharedStack,
          "Hetzner.Server",
          /(Default|Rust|Services)Node\d+$/,
        );
        expect(servers).toHaveLength(3);
        for (const { fqn, attr } of servers) {
          const privateKey = attr.privateKey as Redacted.Redacted<string>;
          const { userData, envFiles } = yield* Effect.gen(function* () {
            const ssh = yield* Hetzner.openSshClient({
              host: attr.ipv4 as string,
              privateKey: Redacted.value(privateKey),
            });
            const userData = yield* ssh.exec(
              "curl -sf http://169.254.169.254/hetzner/v1/userdata || true",
            );
            const envFiles = yield* ssh.exec(
              'for f in /opt/*/env; do [ -f "$f" ] && stat -c \'%a %U %n\' "$f"; done; true',
            );
            yield* ssh.close;
            return { userData: userData.stdout, envFiles: envFiles.stdout };
          }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 6 }));
          expectNoSecrets(userData, token);
          // The node's env reached it over SSH, into a file only root can read.
          const modes = envFiles.trim().split("\n").filter(Boolean);
          expect({ fqn, modes: modes.length > 0 }).toEqual({ fqn, modes: true });
          for (const mode of modes)
            expect({ fqn, mode }).toEqual({ fqn, mode: expect.stringMatching(/^600 root /) });
        }
      }),
      { timeout: 120_000 },
    );

    test(
      "a Rust Durable Object runs on a Hetzner Server pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "hetzner-rust");
      }),
      { timeout: 300_000 },
    );
  },
);
