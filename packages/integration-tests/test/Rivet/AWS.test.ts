import * as AWS from "@alchemy.run/aws";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { Cluster } from "./fixtures/aws/cluster.ts";
import { CounterLive } from "./fixtures/aws/counter-live.ts";
import Front from "./fixtures/aws/front.ts";
import { ClassSecretConfig } from "./fixtures/class-secret.ts";
import { controlPlaneToken, deployed, expectNoSecrets } from "./fixtures/deployed.ts";
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
/** Out-of-band reads run with the AWS credentials and region the stack deploys with. */
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

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
      "every task reads the token and the class's secret from Secrets Manager, never its task definition",
      aws(
        Effect.gen(function* () {
          const token = yield* controlPlaneToken(sharedStack);
          // The counter's pool (whose class reads a secret), the Rust pool,
          // and Rivet Services.
          const services = yield* deployed(
            sharedStack,
            "AWS.ECS.Service",
            /(Default|Rust|Services)Nodes$/,
          );
          expect(services).toHaveLength(3);
          for (const { attr } of services) {
            const { taskDefinition } = yield* ecs.describeTaskDefinition({
              taskDefinition: attr.taskDefinitionArn as string,
            });
            expectNoSecrets(taskDefinition, token);
            const [container] = taskDefinition?.containerDefinitions ?? [];
            const names = (container?.environment ?? []).map((entry) => entry.name);
            expect(names).not.toContain("RIVET_TOKEN");
            // The token by reference: a Secrets Manager secret, pinned to a version.
            const ref = container?.secrets?.find((secret) => secret.name === "RIVET_TOKEN");
            expect(ref?.valueFrom).toMatch(
              /^arn:aws:secretsmanager:[^:]+:\d+:secret:[^:]+:::[0-9a-f-]+$/,
            );
            // The execution role may read exactly the secrets the task names.
            const policy = yield* iam.getRolePolicy({
              RoleName: attr.executionRoleName as string,
              PolicyName: "alchemy-secrets",
            });
            const document = JSON.parse(decodeURIComponent(policy.PolicyDocument ?? "{}")) as {
              Statement: Array<{ Action: string[]; Resource: string[] }>;
            };
            expect(document.Statement.flatMap((statement) => statement.Resource).sort()).toEqual(
              (container?.secrets ?? [])
                .map((secret) => secret.valueFrom.split(":").slice(0, 7).join(":"))
                .sort(),
            );
          }
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "the engines read the admin token from Secrets Manager at boot, never their user data",
      aws(
        Effect.gen(function* () {
          const token = yield* controlPlaneToken(sharedStack);
          const engines = yield* deployed(sharedStack, "AWS.EC2.Instance", /RivetInstance\d+$/);
          expect(engines.length).toBeGreaterThan(0);
          for (const { attr } of engines) {
            const userData = yield* ec2.describeInstanceAttribute({
              InstanceId: attr.instanceId as string,
              Attribute: "userData",
            });
            const script = yield* Effect.sync(() =>
              Buffer.from(userData.UserData?.Value ?? "", "base64").toString("utf8"),
            );
            expectNoSecrets(script, token);
            expect(script).toContain("secretsmanager get-secret-value");
          }
        }),
      ),
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
