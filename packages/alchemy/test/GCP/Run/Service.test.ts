import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { spawnSync } from "node:child_process";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { DataBucket, Tweets } from "./fixtures/bound-resources.ts";
import PublishOnlyService from "./fixtures/service-publish-only.ts";
import BoundRedisService from "./fixtures/service-redis.ts";
import BoundService from "./fixtures/service.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const HELLO_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

const waitUntilGone = (name: string) =>
  cloudrun.getProjectsLocationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a Cloud Run service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Service("Api", {
            location: "us-central1",
            description: "test run service",
            labels: { env: "test" },
            template: {
              containers: [{ image: HELLO_IMAGE }],
            },
          });
        }),
      );

      expect(created.name).toContain("/services/");
      expect(created.serviceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("test run service");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.uri).toEqual(expect.any(String));
      expect(created.terminalConditionState).toEqual("CONDITION_SUCCEEDED");

      const fetched = yield* cloudrun.getProjectsLocationsServices({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("test run service");
      expect(fetched.template?.containers?.[0]?.image).toEqual(HELLO_IMAGE);
      expect(fetched.uri).toEqual(created.uri);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Service("Api", {
            serviceId: created.serviceId,
            location: "us-central1",
            description: "prod run service",
            labels: { env: "prod", role: "api" },
            ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
            template: {
              timeout: "60s",
              containers: [
                {
                  image: HELLO_IMAGE,
                  env: [{ name: "ENV", value: "prod" }],
                },
              ],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("prod run service");
      expect(updated.labels).toMatchObject({ env: "prod", role: "api" });
      expect(updated.ingress).toEqual("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(updated.uri).toEqual(expect.any(String));

      const refetched = yield* cloudrun.getProjectsLocationsServices({
        name: created.name,
      });
      expect(refetched.description).toEqual("prod run service");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("api");
      expect(refetched.ingress).toEqual("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(refetched.template?.timeout).toEqual("60s");
      expect(
        refetched.template?.containers?.[0]?.env?.some(
          (env) => env.name === "ENV" && env.value === "prod",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

class ServiceNotReady extends Data.TaggedError("ServiceNotReady")<{
  status: number;
}> {}

const membersOf = (
  policy: {
    bindings?: ReadonlyArray<{
      role?: string;
      members?: ReadonlyArray<string>;
    }>;
  },
  member: string,
) =>
  new Set(
    (policy.bindings ?? [])
      .filter((binding) => (binding.members ?? []).includes(member))
      .map((binding) => binding.role),
  );

const fetchJson = <A>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : Effect.fail(new ServiceNotReady({ status: response.status })),
      ),
      Effect.retry({
        while: (e): e is ServiceNotReady => e._tag === "ServiceNotReady",
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    return (yield* response.json) as A;
  });

test.provider.skipIf(!hasGcpCreds || !dockerAvailable)(
  "effect-native Function grants resource-scoped IAM and revokes it when a binding is removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = (
        program: typeof BoundService | typeof PublishOnlyService,
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const service = yield* program;
            const topic = yield* Tweets;
            const bucket = yield* DataBucket;
            return {
              uri: service.uri,
              name: service.name,
              project: service.project,
              serviceAccount: service.serviceAccount,
              managedServiceAccount: service.managedServiceAccount,
              topic: topic.name,
              bucket: bucket.bucketName,
            };
          }),
        );

      const out = yield* deployed(BoundService);
      expect(out.managedServiceAccount).toEqual(true);
      expect(out.serviceAccount ?? "").toMatch(/^alch-/);
      const member = `serviceAccount:${out.serviceAccount}`;

      const live = yield* cloudrun.getProjectsLocationsServices({
        name: out.name,
      });
      expect(live.template?.serviceAccount).toEqual(out.serviceAccount);

      // Grants land on the bound resources, never on the project.
      const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
        resource: `projects/${out.project}`,
      });
      expect([...membersOf(projectPolicy, member)]).toEqual([]);
      const topicPolicy = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.topic,
      });
      expect([...membersOf(topicPolicy, member)]).toEqual([
        "roles/pubsub.publisher",
      ]);
      const bucketPolicy = yield* storage.getIamPolicyBuckets({
        bucket: out.bucket,
      });
      expect([...membersOf(bucketPolicy, member)].sort()).toEqual([
        "roles/storage.objectUser",
        "roles/storage.objectViewer",
      ]);

      // The runtime SA's own token publishes and round-trips object content.
      const body = yield* fetchJson<{ published: boolean; read: string }>(
        out.uri!,
      );
      expect(body).toEqual({ published: true, read: "stored" });

      // Step 2: drop the Storage bindings. The code change redeploys and the
      // bucket grants are revoked; the topic grant stays.
      const next = yield* deployed(PublishOnlyService);
      expect(next.serviceAccount).toEqual(out.serviceAccount);
      const bucketAfter = yield* storage.getIamPolicyBuckets({
        bucket: out.bucket,
      });
      expect([...membersOf(bucketAfter, member)]).toEqual([]);
      const topicAfter = yield* pubsub.getIamPolicyProjectsTopics({
        resource: out.topic,
      });
      expect([...membersOf(topicAfter, member)]).toEqual([
        "roles/pubsub.publisher",
      ]);
      const step2 = yield* fetchJson<{ published: boolean; step?: number }>(
        next.uri!,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (response) => response.step === 2,
          times: 15,
        }),
      );
      expect(step2).toEqual({ published: true, step: 2 });

      yield* stack.destroy();

      const saGone = yield* iam
        .getProjectsServiceAccounts({
          name: `projects/${out.project}/serviceAccounts/${out.serviceAccount}`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(saGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 420_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !dockerAvailable || !process.env.GCP_TEST_REDIS,
)(
  "effect-native Function with Memorystore Redis over Direct VPC",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* BoundRedisService;
          return { uri: service.uri };
        }),
      );

      expect(out.uri).toEqual(expect.any(String));
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(out.uri!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new ServiceNotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (e): e is ServiceNotReady => e._tag === "ServiceNotReady",
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      const body = (yield* res.json) as { redis: string | null };
      expect(body.redis).toEqual("ok");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 420_000 },
);
