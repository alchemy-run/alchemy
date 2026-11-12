import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Convex from "@alchemy.run/convex/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { assertDevAccount } from "./guard.ts";
import { assertRuntime, listMessages, skipPaid, TEST_DOMAIN } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });

const EXAMPLE = NodePath.join(
  import.meta.dirname,
  "../../../../../examples/aws-convex-self-hosted",
);

/** Drives the example the way a person does, through the real CLI and state store. */
const alchemy = (...args: string[]) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(
      () =>
        new Promise<{ code: number | null; output: string }>((resolve) => {
          const child = NodeChildProcess.spawn(
            "pnpm",
            [
              "exec",
              "alchemy",
              ...args,
              "--profile",
              process.env.ALCHEMY_PROFILE ?? "testing",
              "--yes",
            ],
            {
              cwd: EXAMPLE,
              env: { ...process.env, CONVEX_DOMAIN: TEST_DOMAIN },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.on("close", (code) => resolve({ code, output }));
        }),
    );
    if (result.code !== 0) {
      const lines = result.output.split("\n").filter((line) => !/^\s+at /.test(line));
      return yield* Effect.die(`alchemy ${args.join(" ")} failed:\n${lines.slice(-30).join("\n")}`);
    }
    return result.output;
  });

const taskDefinitionOf = (stage: string) =>
  Effect.gen(function* () {
    const { clusterArns } = yield* ecs.listClusters({});
    for (const cluster of clusterArns ?? []) {
      const { serviceArns } = yield* ecs.listServices({ cluster });
      // `-alice-` also starts `-alice-2-`, so a stage's name must not run on into a number.
      const named = new RegExp(`-${stage}-(?!\\d+-)`);
      const service = (serviceArns ?? []).find((arn) => named.test(arn.toLowerCase()));
      if (service === undefined) continue;
      const { services } = yield* ecs.describeServices({ cluster, services: [service] });
      const { taskDefinition } = yield* ecs.describeTaskDefinition({
        taskDefinition: services![0]!.taskDefinition!,
      });
      return taskDefinition!;
    }
    return yield* Effect.die(`no service for ${stage}`);
  });

const UUID = "3f2b9c1e-0000-4000-8000-000000000000";

test.provider.skipIf(skipPaid)(
  "two stages share one platform and stay apart",
  () =>
    Effect.gen(function* () {
      yield* assertDevAccount;
      yield* alchemy("deploy", "stacks/platform.ts", "--stage", "dev");
      const alice = yield* alchemy("deploy", "--stage", "alice");
      yield* alchemy("deploy", "--stage", "alice-2");

      const aliceUrl = `https://alice-cloud.${TEST_DOMAIN}`;
      const otherUrl = `https://alice-2-cloud.${TEST_DOMAIN}`;

      // The TanStack Start site serves, on the real Website component.
      const websiteUrl = /websiteUrl: '([^']+)'/.exec(alice)?.[1];
      expect(websiteUrl).toBeDefined();
      const http = yield* HttpClient.HttpClient;
      const page = yield* http.get(websiteUrl!);
      expect(page.status).toBe(200);
      expect(yield* page.text).toContain("Convex on AWS");

      // Both stages work, and a row in one is absent from the other.
      yield* assertRuntime({ url: aliceUrl, text: "only in alice" });
      yield* assertRuntime({ url: otherUrl, text: "only in the other stage" });
      expect(yield* listMessages(otherUrl)).not.toContain("only in alice");
      expect(yield* listMessages(aliceUrl)).not.toContain("only in the other stage");

      // Stage `convexapp-alice` can't reach `convexapp-alice-2`, whose name starts the same.
      const task = yield* taskDefinitionOf("alice");
      const bucket = task.containerDefinitions![0]!.environment!.find(
        (entry) => entry.name === "S3_STORAGE_FILES_BUCKET",
      )!.value!;
      const own = `convexapp-alice-${UUID}/object`;
      const neighbour = `convexapp-alice-2-${UUID}/object`;
      const canRead = (key: string) =>
        iam
          .simulatePrincipalPolicy({
            PolicySourceArn: task.taskRoleArn!,
            ActionNames: ["s3:GetObject"],
            ResourceArns: [`arn:aws:s3:::${bucket}/${key}`],
          })
          .pipe(Effect.map((result) => result.EvaluationResults?.[0]?.EvalDecision));
      expect(yield* canRead(own)).toBe("allowed");
      expect(yield* canRead(neighbour)).toBe("implicitDeny");

      // Listing is limited the same way, and a list with no prefix is refused.
      const canList = (prefix: string | undefined) =>
        iam
          .simulatePrincipalPolicy({
            PolicySourceArn: task.taskRoleArn!,
            ActionNames: ["s3:ListBucket"],
            ResourceArns: [`arn:aws:s3:::${bucket}`],
            ContextEntries:
              prefix === undefined
                ? []
                : [
                    {
                      ContextKeyName: "s3:prefix",
                      ContextKeyType: "string",
                      ContextKeyValues: [prefix],
                    },
                  ],
          })
          .pipe(Effect.map((result) => result.EvaluationResults?.[0]?.EvalDecision));
      expect(yield* canList(`convexapp-alice-${UUID}/`)).toBe("allowed");
      expect(yield* canList(`convexapp-alice-2-${UUID}/`)).toBe("implicitDeny");
      expect(yield* canList(undefined)).toBe("implicitDeny");

      // Destroying a stage deletes its prefix and leaves the other stage's alone.
      yield* s3.putObject({ Bucket: bucket, Key: own, Body: "mine" });
      yield* s3.putObject({ Bucket: bucket, Key: neighbour, Body: "theirs" });
      yield* alchemy("destroy", "--stage", "alice");
      const listed = yield* s3.listObjectsV2({ Bucket: bucket, Prefix: "convexapp-alice-" });
      const keys = (listed.Contents ?? []).map((object) => object.Key);
      expect(keys).not.toContain(own);
      expect(keys).toContain(neighbour);

      // The other stage keeps running on the shared platform.
      expect(yield* listMessages(otherUrl)).toContain("only in the other stage");
      yield* s3.deleteObject({ Bucket: bucket, Key: neighbour });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.exit(alchemy("destroy", "--stage", "alice"));
          yield* Effect.exit(alchemy("destroy", "--stage", "alice-2"));
          yield* Effect.exit(alchemy("destroy", "stacks/platform.ts", "--stage", "dev"));
        }),
      ),
    ),
  {
    tags: ["provider:convex", "provider:convex:backend", "provider:aws", "live"],
    timeout: 4_500_000,
  },
);
