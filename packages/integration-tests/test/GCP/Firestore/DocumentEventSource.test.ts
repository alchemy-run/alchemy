import * as GCP from "@alchemy.run/gcp";
import { encodeFields } from "@alchemy.run/gcp/Firestore/Values";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import DocumentEventsService, {
  ChangeMarkers,
  Changes,
  marker,
} from "./fixtures/document-events.ts";

const { test } = Test.make({ providers: GCP.providers() });

class NotDeliveredYet extends Data.TaggedError("NotDeliveredYet") {}

test.provider(
  "document changes reach an effect-native Function through Eventarc",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          yield* DocumentEventsService;
          return {
            database: (yield* Changes).name,
            bucket: (yield* ChangeMarkers).bucketName,
          };
        }),
      );

      const write = (path: string, fields: Record<string, unknown>) =>
        firestore.patchProjectsDatabasesDocuments({
          name: `${out.database}/documents/${path}`,
          body: { fields: encodeFields(fields) },
        });
      const media = yield* makeObjectMedia;
      const read = (object: string) =>
        media.download({ bucket: out.bucket, object }).pipe(
          Effect.retry({
            while: (error) => error._tag === "GCP.Storage.ObjectNotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 36,
          }),
          Effect.map((downloaded) => JSON.parse(new TextDecoder().decode(downloaded.body))),
        );

      // Deliveries are refused (403) until the host's invoker grant on itself
      // propagates, which takes up to several minutes: write warm-up items
      // until one arrives.
      yield* Effect.gen(function* () {
        const id = `warmup-${yield* Effect.sync(() => crypto.randomUUID().slice(0, 8))}`;
        yield* write(`items/${id}`, { warmup: true });
        yield* Effect.sleep("20 seconds");
        const { items = [] } = yield* storage.listObjects({
          bucket: out.bucket,
          prefix: marker("items", "created", `items/${id}`),
        });
        if (items.length === 0) return yield* new NotDeliveredYet();
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotDeliveredYet",
          schedule: Schedule.spaced("1 second"),
          times: 30,
        }),
      );

      // Out of band: create, update and delete one item; write a nested log.
      yield* write("items/apple", { price: 1 });
      expect(yield* read(marker("items", "created", "items/apple"))).toMatchObject({
        kind: "created",
        document: "items/apple",
        value: { price: 1 },
        params: { itemId: "apple" },
      });
      yield* write("items/apple", { price: 2 });
      expect(yield* read(marker("items", "updated", "items/apple"))).toMatchObject({
        kind: "updated",
        value: { price: 2 },
        oldValue: { price: 1 },
        updatedFields: ["price"],
      });
      yield* firestore.deleteProjectsDatabasesDocuments({
        name: `${out.database}/documents/items/apple`,
      });
      expect(yield* read(marker("items", "deleted", "items/apple"))).toMatchObject({
        kind: "deleted",
        oldValue: { price: 2 },
      });

      yield* write("logs/2026/entries/one", { level: "info" });
      expect(yield* read(marker("logs", "created", "logs/2026/entries/one"))).toMatchObject({
        kind: "created",
        value: { level: "info" },
        params: { path: "2026/entries/one" },
      });

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);
