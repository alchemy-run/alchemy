import * as AWS from "@alchemy.run/aws";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { instanceUserData, serviceContainers } from "./fixtures/aws-checks.ts";
import { Cluster } from "./fixtures/aws/cluster.ts";
import { CounterLive } from "./fixtures/aws/counter-live.ts";
import Front from "./fixtures/aws/front.ts";
import { CLASS_SECRET, CLASS_SECRET_NAME, ClassSecretConfig } from "./fixtures/class-secret.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetAwsConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own.
const RustPool = RivetAWS.EcsPool("Rust", { architecture: "ARM64" }).pipe(Layer.provide(Cluster));

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on EC2 and a pool on ECS Fargate, called from a Lambda.
describe.skipIf(!!process.env.FAST)(
  "Rivet on AWS (EC2 control plane, ECS pool)",
  { tags: ["provider:rivet", "provider:aws", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            const actors = yield* RustActors().pipe(Effect.provide(RustPool));
            return { url: front.functionUrl, rust: rustTarget(actors) };
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
      "the token and a class's secret come from Secrets Manager, never a task definition or user data",
      Effect.gen(function* () {
        const { containers, instances } = yield* Core.withProviders(
          Effect.all({
            containers: serviceContainers(sharedStack),
            instances: instanceUserData(sharedStack),
          }),
          testOptions,
          sharedStack.name,
        );
        // Default, Rust and Services read the token as a secret.
        const nodes = containers.filter((container) => "RIVET_TOKEN" in container.secrets);
        expect(nodes).toHaveLength(3);
        for (const container of containers) {
          expect(container.environment).not.toHaveProperty("RIVET_TOKEN");
          expect(container.environment).not.toHaveProperty(CLASS_SECRET_NAME);
        }
        expect(JSON.stringify(containers)).not.toContain(CLASS_SECRET);
        expect(nodes.every((node) => node.secrets.RIVET_TOKEN?.startsWith("arn:"))).toBe(true);
        // The engines read their admin token at boot.
        expect(instances.length).toBeGreaterThan(0);
        for (const { userData } of instances) {
          expect(userData).not.toMatch(/RIVET__AUTH__ADMIN_TOKEN="/);
          expect(userData).toContain("secretsmanager get-secret-value");
        }
      }),
      { timeout: 120_000 },
    );

    test(
      "a Rust Durable Object runs on an ECS pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "aws-rust");
      }),
      { timeout: 300_000 },
    );
  },
);
