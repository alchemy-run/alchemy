import * as GCP from "@alchemy.run/gcp";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import SecretEventsService, { EventMarkers, Notifying } from "./fixtures/secret-events.ts";

const { test } = Test.make({ providers: GCP.providers() });

/** Markers the consumer wrote for `eventType`, once at least one exists. */
const markersFor = (bucket: string, eventType: string) =>
  storage.listObjects({ bucket, prefix: `${eventType}/` }).pipe(
    Effect.map((list) => list.items ?? []),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (items) => items.length > 0,
      times: 36,
    }),
  );

test.provider(
  "a secret's notifications reach an effect-native Function, filtered by event type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          yield* SecretEventsService;
          return {
            secret: (yield* Notifying).name,
            bucket: (yield* EventMarkers).bucketName,
          };
        }),
      );

      // The event source bound its topic onto the secret.
      const secret = yield* secretmanager.getProjectsSecrets({ name: out.secret });
      expect(secret.topics?.map((t) => t.name)).toEqual([
        expect.stringContaining("notifying-secretevents"),
      ]);

      // Out of band: every subscribed kind of change, plus one filtered out.
      const version = yield* secretmanager.addVersionProjectsSecrets({
        parent: out.secret,
        body: { payload: { data: btoa("v1") } },
      });
      yield* secretmanager.disableProjectsSecretsVersions({ name: version.name!, body: {} });
      yield* secretmanager.enableProjectsSecretsVersions({ name: version.name!, body: {} });
      yield* secretmanager.destroyProjectsSecretsVersions({ name: version.name!, body: {} });
      yield* secretmanager.patchProjectsSecrets({
        name: out.secret,
        updateMask: "annotations",
        body: { annotations: { touched: "yes" } },
      });

      const media = yield* makeObjectMedia;
      for (const eventType of [
        "SECRET_VERSION_ADD",
        "SECRET_VERSION_DISABLE",
        "SECRET_VERSION_DESTROY",
        "SECRET_UPDATE",
      ]) {
        const [marker] = yield* markersFor(out.bucket, eventType);
        expect(marker).toBeDefined();
        const object = yield* media.download({ bucket: out.bucket, object: marker!.name! });
        const event = JSON.parse(new TextDecoder().decode(object.body));
        expect(event).toMatchObject({ eventType, secret: out.secret });
        if (eventType !== "SECRET_UPDATE") expect(event.version).toEqual(version.name);
      }
      const filtered = yield* storage.listObjects({
        bucket: out.bucket,
        prefix: "SECRET_VERSION_ENABLE/",
      });
      expect(filtered.items ?? []).toEqual([]);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
