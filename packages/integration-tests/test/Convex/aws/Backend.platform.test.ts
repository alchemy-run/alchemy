import * as NodePath from "node:path";
import * as Convex from "@alchemy.run/convex/aws";
import { hostLabelOf, instanceNameOf } from "@alchemy.run/convex/internal/selfhosted";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { assertDevAccount } from "./guard.ts";
import { assertRuntime, listMessages, skipPaid, TEST_DOMAIN } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });

const EXAMPLE = NodePath.join(
  import.meta.dirname,
  "../../../../../examples/aws-convex-self-hosted",
);

/** Drives the example the way a person does, through the real CLI and state store. */
const alchemy = (platformStage: string, ...args: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const profile = yield* Config.String("ALCHEMY_PROFILE").pipe(Config.withDefault("testing"));
      const child = yield* spawner.spawn(
        ChildProcess.make("pnpm", ["exec", "alchemy", ...args, "--profile", profile, "--yes"], {
          cwd: EXAMPLE,
          env: { CONVEX_DOMAIN: TEST_DOMAIN, CONVEX_PLATFORM_STAGE: platformStage },
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      const [output, code] = yield* Effect.all(
        [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: 2 },
      );
      // Each resource's time is in the output, so keep it in the test log.
      yield* Effect.logInfo(`alchemy ${args.join(" ")}\n${output}`);
      if (code !== 0) {
        const lines = output.split("\n").filter((line) => !/^\s+at /.test(line));
        return yield* Effect.die(
          `alchemy ${args.join(" ")} failed:\n${lines.slice(-30).join("\n")}`,
        );
      }
      return output;
    }),
  );

/** The task definition of the stage whose backend runs as `instance`. */
const taskDefinitionOf = (instance: string) =>
  Effect.gen(function* () {
    const { clusterArns } = yield* ecs.listClusters({});
    for (const cluster of clusterArns ?? []) {
      const { serviceArns } = yield* ecs.listServices({ cluster });
      if ((serviceArns ?? []).length === 0) continue;
      const { services } = yield* ecs.describeServices({ cluster, services: serviceArns! });
      for (const service of services ?? []) {
        const { taskDefinition } = yield* ecs.describeTaskDefinition({
          taskDefinition: service.taskDefinition!,
        });
        const env = taskDefinition!.containerDefinitions?.[0]?.environment ?? [];
        if (env.some((entry) => entry.name === "INSTANCE_NAME" && entry.value === instance)) {
          return taskDefinition!;
        }
      }
    }
    return yield* Effect.die(`no service runs ${instance}`);
  });

const UUID = "3f2b9c1e-0000-4000-8000-000000000000";

test.provider.skipIf(skipPaid)(
  "two SQLite stages share one platform and stay apart",
  (stack) =>
    Effect.gen(function* () {
      // Stages and the platform are this run's own, never the example's `dev`.
      const base = hostLabelOf(stack.stage);
      const platform = `${base}-platform`;
      const one = base;
      const two = `${base}-2`;
      const cli = (...args: string[]) => alchemy(platform, ...args);
      const oneInstance = instanceNameOf("ConvexApp", one);
      const twoInstance = instanceNameOf("ConvexApp", two);

      return yield* Effect.gen(function* () {
        yield* assertDevAccount;
        yield* cli("deploy", "stacks/platform.ts", "--stage", platform);

        // Once the platform exists, a preview stage is up within five minutes.
        const [firstTook, first] = yield* Effect.timed(cli("deploy", "--stage", one));
        const [secondTook] = yield* Effect.timed(cli("deploy", "--stage", two));
        yield* Effect.logInfo(
          `stage deploys took ${Duration.format(firstTook)} and ${Duration.format(secondTook)}`,
        );

        const oneUrl = `https://${one}.cloud.${TEST_DOMAIN}`;
        const twoUrl = `https://${two}.cloud.${TEST_DOMAIN}`;

        // The TanStack Start site serves, on the real Website component.
        const websiteUrl = /websiteUrl: '([^']+)'/.exec(first)?.[1];
        expect(websiteUrl).toBeDefined();
        const http = yield* HttpClient.HttpClient;
        const page = yield* http.get(websiteUrl!);
        expect(page.status).toBe(200);
        expect(yield* page.text).toContain("Convex on AWS");

        // Both stages work, and a row in one is absent from the other.
        yield* assertRuntime({ url: oneUrl, text: "only in the first stage" });
        yield* assertRuntime({ url: twoUrl, text: "only in the other stage" });
        expect(yield* listMessages(twoUrl)).not.toContain("only in the first stage");
        expect(yield* listMessages(oneUrl)).not.toContain("only in the other stage");

        // The first stage can't reach the second, whose instance name starts the same.
        const task = yield* taskDefinitionOf(oneInstance);
        const bucket = task.containerDefinitions![0]!.environment!.find(
          (entry) => entry.name === "S3_STORAGE_FILES_BUCKET",
        )!.value!;
        const own = `${oneInstance}-${UUID}/object`;
        const neighbour = `${twoInstance}-${UUID}/object`;
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
        expect(yield* canList(`${oneInstance}-${UUID}/`)).toBe("allowed");
        expect(yield* canList(`${twoInstance}-${UUID}/`)).toBe("implicitDeny");
        expect(yield* canList(undefined)).toBe("implicitDeny");

        // Destroying a stage deletes its prefix and leaves the other stage's alone.
        yield* s3.putObject({ Bucket: bucket, Key: own, Body: "mine" });
        yield* s3.putObject({ Bucket: bucket, Key: neighbour, Body: "theirs" });
        yield* cli("destroy", "--stage", one);
        const listed = yield* s3.listObjectsV2({ Bucket: bucket, Prefix: `${oneInstance}-` });
        const keys = (listed.Contents ?? []).map((object) => object.Key);
        expect(keys).not.toContain(own);
        expect(keys).toContain(neighbour);

        // The other stage keeps running on the shared platform.
        expect(yield* listMessages(twoUrl)).toContain("only in the other stage");
        yield* s3.deleteObject({ Bucket: bucket, Key: neighbour });

        // Checked last, so a slow deploy doesn't hide a broken one.
        expect(Duration.toMinutes(firstTook)).toBeLessThan(5);
        expect(Duration.toMinutes(secondTook)).toBeLessThan(5);

        // The platform goes last, and leaves nothing behind.
        yield* cli("destroy", "--stage", two);
        yield* cli("destroy", "stacks/platform.ts", "--stage", platform);
        const { Buckets } = yield* s3.listBuckets({});
        expect((Buckets ?? []).map((item) => item.Name)).not.toContain(bucket);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Effect.exit(cli("destroy", "--stage", one));
            yield* Effect.exit(cli("destroy", "--stage", two));
            yield* Effect.exit(cli("destroy", "stacks/platform.ts", "--stage", platform));
          }),
        ),
      );
    }),
  {
    tags: ["provider:convex", "provider:convex:backend", "provider:aws", "live"],
    timeout: 4_500_000,
  },
);
