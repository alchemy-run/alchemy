import * as AWS from "@alchemy.run/aws";
import { createAssetsBucketName } from "@alchemy.run/aws/Assets";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetAWS from "@alchemy.run/rivet/AWS";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { Cluster } from "./fixtures/aws/ecs-cluster.ts";
import { CounterLive } from "./fixtures/aws/ecs-counter-live.ts";
import Front from "./fixtures/aws/ecs-front.ts";
import { ClassSecretConfig } from "./fixtures/class-secret.ts";
import { controlPlaneToken, deployed, expectNoSecrets } from "./fixtures/deployed.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetAwsEcsConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own.
const RustPool = RivetAWS.Ec2Pool("Rust").pipe(Layer.provide(Cluster));
/** Out-of-band reads run with the AWS credentials and region the stack deploys with. */
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on ECS and a pool of EC2 instances, called from a Lambda.
describe.skipIf(!!process.env.FAST)(
  "Rivet on AWS (ECS control plane, EC2 pool)",
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
      "every instance reads the token and the class's secret from Secrets Manager, never S3 or user data",
      aws(
        Effect.gen(function* () {
          const token = yield* controlPlaneToken(sharedStack);
          const { accountId, region } = yield* AWSEnvironment.current;
          const bucket = createAssetsBucketName(accountId, region);
          const read = (key: string) =>
            s3
              .getObject({ Bucket: bucket, Key: key })
              .pipe(Effect.flatMap((object) => Stream.mkString(Stream.decodeText(object.Body!))));
          // The counter's pool (whose class reads a secret) and the Rust pool.
          const nodes = yield* deployed(sharedStack, "AWS.EC2.Instance", /(Default|Rust)Node\d+$/);
          expect(nodes).toHaveLength(2);
          for (const { attr } of nodes) {
            const userData = yield* ec2.describeInstanceAttribute({
              InstanceId: attr.instanceId as string,
              Attribute: "userData",
            });
            const script = yield* Effect.sync(() =>
              Buffer.from(userData.UserData?.Value ?? "", "base64").toString("utf8"),
            );
            expectNoSecrets(script, token);
            // The env file the instance syncs from S3 holds neither.
            const env = yield* read(`${attr.assetPrefix}/env`);
            expectNoSecrets(env, token);
            expect(env).not.toMatch(/^RIVET_TOKEN=/m);
            // Only where the token is: a Secrets Manager secret, pinned to a version.
            const secrets = yield* read(`${attr.assetPrefix}/secrets`);
            expect(secrets).toMatch(
              /^RIVET_TOKEN=arn:aws:secretsmanager:[^:]+:\d+:secret:[^:]+:::[0-9a-f-]+$/m,
            );
            // The instance's role may read exactly those secrets.
            const policy = yield* iam.getRolePolicy({
              RoleName: attr.roleName as string,
              PolicyName: attr.policyName as string,
            });
            const granted = (
              JSON.parse(decodeURIComponent(policy.PolicyDocument ?? "{}")) as {
                Statement: Array<{ Action: string[]; Resource: string[] }>;
              }
            ).Statement.filter((statement) =>
              statement.Action.includes("secretsmanager:GetSecretValue"),
            ).flatMap((statement) => statement.Resource);
            expect(granted.sort()).toEqual(
              secrets
                .trim()
                .split("\n")
                .map((line) =>
                  line
                    .slice(line.indexOf("=") + 1)
                    .split(":")
                    .slice(0, 7)
                    .join(":"),
                )
                .sort(),
            );
          }
          // Rivet Services on ECS: the token by reference only.
          const [services] = yield* deployed(sharedStack, "AWS.ECS.Service", /ServicesNodes$/);
          const { taskDefinition } = yield* ecs.describeTaskDefinition({
            taskDefinition: services!.attr.taskDefinitionArn as string,
          });
          expectNoSecrets(taskDefinition, token);
          expect(
            taskDefinition?.containerDefinitions?.[0]?.secrets?.map((secret) => secret.name),
          ).toEqual(["RIVET_TOKEN"]);
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "the engines' tasks read the admin token from Secrets Manager, never their task definition or user data",
      aws(
        Effect.gen(function* () {
          const token = yield* controlPlaneToken(sharedStack);
          const engines = yield* deployed(sharedStack, "AWS.ECS.Service", /RivetEngine\d+$/);
          expect(engines.length).toBeGreaterThan(0);
          for (const { attr } of engines) {
            const { taskDefinition } = yield* ecs.describeTaskDefinition({
              taskDefinition: attr.taskDefinitionArn as string,
            });
            expectNoSecrets(taskDefinition, token);
            const [container] = taskDefinition?.containerDefinitions ?? [];
            expect(container?.secrets?.map((secret) => secret.name)).toEqual([
              "RIVET__AUTH__ADMIN_TOKEN",
            ]);
          }
          const hosts = yield* deployed(sharedStack, "AWS.EC2.Instance", /RivetInstance\d+$/);
          expect(hosts.length).toBeGreaterThan(0);
          for (const { attr } of hosts) {
            const userData = yield* ec2.describeInstanceAttribute({
              InstanceId: attr.instanceId as string,
              Attribute: "userData",
            });
            expectNoSecrets(
              yield* Effect.sync(() =>
                Buffer.from(userData.UserData?.Value ?? "", "base64").toString("utf8"),
              ),
              token,
            );
          }
        }),
      ),
      { timeout: 120_000 },
    );

    test(
      "a Rust Durable Object runs on an EC2 pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "awsecs-rust");
      }),
      { timeout: 300_000 },
    );
  },
);
