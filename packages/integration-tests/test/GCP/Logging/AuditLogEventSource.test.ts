import * as GCP from "@alchemy.run/gcp";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import AuditLogsService, { Markers, markerPrefix, Watched } from "./fixtures/audit-logs.ts";

const { test } = Test.make({ providers: GCP.providers() });

class NotDeliveredYet extends Data.TaggedError("NotDeliveredYet") {}

/** Marker objects the consumer wrote for `method`, once at least one exists. */
const markersFor = (bucket: string, method: string) =>
  storage.listObjects({ bucket, prefix: markerPrefix(method) }).pipe(
    Effect.map((list) => list.items ?? []),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (items) => items.length > 0,
      times: 30,
    }),
  );

test.provider(
  "a secret's audit log entries reach an effect-native Function through a Logging sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          yield* AuditLogsService;
          return { secret: (yield* Watched).name, bucket: (yield* Markers).bucketName };
        }),
      );

      // The sink routes only this secret's audit entries for the two methods.
      const { sinks = [] } = yield* logging.listProjectsSinks({
        parent: `projects/${out.secret.split("/")[1]}`,
      });
      const sink = sinks.find((s) => (s.filter ?? "").includes(out.secret.split("/").at(-1)!));
      expect(sink?.destination).toContain("pubsub.googleapis.com/projects/");
      expect(sink?.filter).toContain('protoPayload.serviceName=("secretmanager.googleapis.com")');
      expect(sink?.filter).toContain("AddSecretVersion|DisableSecretVersion");

      // Admin Activity calls on the secret, out of band. The sink drops
      // entries until its publisher grant on the topic propagates, so add
      // versions until the first one is delivered.
      const version = yield* Effect.gen(function* () {
        const added = yield* secretmanager.addVersionProjectsSecrets({
          parent: out.secret,
          body: { payload: { data: btoa("audited") } },
        });
        yield* Effect.sleep("20 seconds");
        const { items = [] } = yield* storage.listObjects({
          bucket: out.bucket,
          prefix: markerPrefix("AddSecretVersion"),
        });
        if (items.length === 0) return yield* new NotDeliveredYet();
        return added;
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotDeliveredYet",
          schedule: Schedule.spaced("1 second"),
          times: 15,
        }),
      );
      yield* secretmanager.disableProjectsSecretsVersions({ name: version.name!, body: {} });
      // Not subscribed: must not be delivered.
      yield* secretmanager.enableProjectsSecretsVersions({ name: version.name!, body: {} });

      const media = yield* makeObjectMedia;
      for (const method of ["AddSecretVersion", "DisableSecretVersion"]) {
        const [marker] = yield* markersFor(out.bucket, method);
        expect(marker).toBeDefined();
        const object = yield* media.download({ bucket: out.bucket, object: marker!.name! });
        const event = JSON.parse(new TextDecoder().decode(object.body));
        expect(event).toMatchObject({
          serviceName: "secretmanager.googleapis.com",
          methodName: `google.cloud.secretmanager.v1.SecretManagerService.${method}`,
          logName: expect.stringContaining("cloudaudit.googleapis.com%2Factivity"),
        });
        expect(event.resourceName).toContain(`/secrets/${out.secret.split("/").at(-1)}`);
      }
      const unsubscribed = yield* storage.listObjects({
        bucket: out.bucket,
        prefix: markerPrefix("EnableSecretVersion"),
      });
      expect(unsubscribed.items ?? []).toEqual([]);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
