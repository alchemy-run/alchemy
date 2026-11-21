import * as AWS from "@alchemy.run/aws";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { conformanceTests, waitForReady } from "./conformance.ts";
import Front from "./fixtures/aws/front.ts";
import { Lives } from "./fixtures/aws/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(AWS.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterAws", import.meta.url);

let baseUrl = "";

/** Out-of-band reads run with the AWS credentials and region the stack deploys with. */
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

/** The task definition of every runner service the stack deployed, from its state. */
const runnerTaskDefinitions = Effect.gen(function* () {
  const state = yield* yield* State.State;
  const at = { stack: sharedStack.name, stage: sharedStack.stage };
  const arns: string[] = [];
  for (const fqn of yield* state.list(at)) {
    const row = yield* state.get({ ...at, fqn });
    if (State.isResourceState(row) && row.resourceType === "AWS.ECS.Service" && row.attr) {
      arns.push((row.attr as { taskDefinitionArn: string }).taskDefinitionArn);
    }
  }
  return arns;
}).pipe(Effect.provide(sharedStack.state));

// The Effect Cluster conformance cases, against Postgres on RDS and runners
// on ECS Fargate, called from a Lambda function through the public gateways.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on AWS (RDS, ECS)",
  { tags: ["provider:cluster", "provider:aws", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.functionUrl };
          }).pipe(Effect.provide(Lives)),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl);
      }),
      { timeout: 1_800_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 1_200_000 });

    test(
      "runner task definitions name the database URL and gateway token, never hold them",
      aws(
        Effect.gen(function* () {
          const arns = yield* runnerTaskDefinitions;
          // The Default and Legacy pools.
          expect(arns).toHaveLength(2);
          for (const arn of arns) {
            const { taskDefinition } = yield* ecs.describeTaskDefinition({ taskDefinition: arn });
            const container = taskDefinition?.containerDefinitions?.[0];
            const environment = container?.environment ?? [];
            expect(environment.map((variable) => variable.name)).not.toContain(
              "CLUSTER_DATABASE_URL",
            );
            expect(environment.map((variable) => variable.name)).not.toContain(
              "CLUSTER_GATEWAY_TOKEN",
            );
            // Only references, each a Secrets Manager secret pinned to a version.
            const refs = container?.secrets ?? [];
            expect(refs.map((ref) => ref.name).sort()).toEqual([
              "CLUSTER_DATABASE_URL",
              "CLUSTER_GATEWAY_TOKEN",
            ]);
            const config = JSON.stringify(taskDefinition);
            for (const ref of refs) {
              expect(ref.valueFrom).toMatch(
                /^arn:aws:secretsmanager:[^:]+:\d+:secret:[^:]+:::[0-9a-f-]+$/,
              );
              const parts = ref.valueFrom!.split(":");
              const { SecretString } = yield* secretsmanager.getSecretValue({
                SecretId: parts.slice(0, 7).join(":"),
                VersionId: parts[9],
              });
              const value =
                SecretString === undefined
                  ? ""
                  : Redacted.isRedacted(SecretString)
                    ? Redacted.value(SecretString)
                    : SecretString;
              expect(value.length).toBeGreaterThan(8);
              // Neither the value, nor the password inside the URL.
              const pieces =
                ref.name === "CLUSTER_DATABASE_URL"
                  ? [value, decodeURIComponent(new URL(value).password)]
                  : [value];
              for (const piece of pieces) {
                expect(piece.length).toBeGreaterThan(8);
                expect(environment.some((variable) => variable.value?.includes(piece))).toBe(false);
                expect(config).not.toContain(piece);
              }
            }
          }
        }),
      ),
      { timeout: 120_000 },
    );

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
  },
);
