import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectFound } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  secretmanager.getProjectsSecrets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.Secret("ApiKey", {
            labels: { env: "test" },
            annotations: { owner: "payments" },
          });
        }),
      );
      yield* expectFound(GCP.SecretManager.Secret.lookup({ secretId: created.secretId }), created);

      expect(created.name).toContain("/secrets/");
      expect(created.secretId).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.annotations).toMatchObject({ owner: "payments" });
      expect(created.replication?.automatic).toBeDefined();

      const fetched = yield* secretmanager.getProjectsSecrets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.annotations?.owner).toEqual("payments");
      expect(fetched.replication?.automatic).toBeDefined();

      const payload = yield* Effect.sync(() =>
        Buffer.from("alchemy-secret-payload", "utf8").toString("base64"),
      );
      const version = yield* secretmanager.addVersionProjectsSecrets({
        parent: created.name,
        body: { payload: { data: payload } },
      });
      expect(version.name).toContain("/versions/");

      const accessed = yield* secretmanager.accessProjectsSecretsVersions({
        name: `${created.name}/versions/latest`,
      });
      expect(accessed.payload?.data).toEqual(payload);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.Secret("ApiKey", {
            secretId: created.secretId,
            labels: { env: "prod", role: "api" },
            annotations: { owner: "platform" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "api" });
      expect(updated.annotations).toMatchObject({ owner: "platform" });

      const fetchedUpdate = yield* secretmanager.getProjectsSecrets({
        name: created.name,
      });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("api");
      expect(fetchedUpdate.annotations?.owner).toEqual("platform");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "replace a secret when replication changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.Secret("RegionalKey", {
            replication: { automatic: {} },
          });
        }),
      );

      expect(created.replication?.automatic).toBeDefined();
      expect(created.replication?.userManaged).toBeUndefined();

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.Secret("RegionalKey", {
            secretId: created.secretId,
            replication: {
              userManaged: {
                replicas: [{ location: "us-central1" }],
              },
            },
          });
        }),
      );

      expect(replaced.name).toEqual(created.name);
      expect(replaced.secretId).toEqual(created.secretId);
      expect(replaced.replication?.automatic).toBeUndefined();
      expect(replaced.replication?.userManaged?.replicas?.[0]?.location).toEqual("us-central1");

      const fetched = yield* secretmanager.getProjectsSecrets({
        name: replaced.name,
      });
      expect(fetched.replication?.automatic).toBeUndefined();
      expect(fetched.replication?.userManaged?.replicas?.[0]?.location).toEqual("us-central1");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "a secret's value is written at deploy, as a new version only when it changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = (value: string) =>
        GCP.SecretManager.Secret("Token", { value: Redacted.make(value) });
      const valueOf = (name: string) =>
        secretmanager
          .accessProjectsSecretsVersions({ name })
          .pipe(
            Effect.flatMap((response) =>
              Effect.sync(() =>
                Buffer.from(response.payload?.data ?? "", "base64").toString("utf8"),
              ),
            ),
          );

      const first = yield* stack.deploy(secret("first"));
      expect(first.version).toMatch(/\/versions\/\d+$/);
      expect(yield* valueOf(first.version!)).toEqual("first");

      // The same value plans no change and adds no version.
      expect((yield* stack.plan(secret("first"))).resources.Token).toMatchObject({
        action: "noop",
      });
      expect((yield* stack.deploy(secret("first"))).version).toEqual(first.version);

      const second = yield* stack.deploy(secret("second"));
      expect(second.name).toEqual(first.name);
      expect(second.version).not.toEqual(first.version);
      expect(yield* valueOf(second.version!)).toEqual("second");
      expect(yield* valueOf(`${second.name}/versions/latest`)).toEqual("second");
      // The earlier version still holds what it held.
      expect(yield* valueOf(first.version!)).toEqual("first");

      yield* stack.destroy();
      expect(yield* waitUntilGone(second.name)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:secretmanager", "live"],
    timeout: 90_000,
  },
);
