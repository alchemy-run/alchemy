import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dict from "@distilled.cloud/modal/dict";
import * as queue from "@distilled.cloud/modal/queue";
import * as secret from "@distilled.cloud/modal/secret";
import * as volume from "@distilled.cloud/modal/volume";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ObjectsWorker from "./fixtures/objects-worker.ts";
import { hostIdentity } from "./hostIdentity.ts";

const providers = Layer.mergeAll(Modal.providers(), Cloudflare.providers(), hostIdentity);
const { test } = Test.make({ providers });

const tags = ["provider:modal", "provider:modal:objects", "provider:cloudflare", "live"];

test.provider(
  "objects a runtime creates carry its stack, stage and host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ObjectsWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const res = yield* client
        .get(`${url}?key=t1`)
        .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
      const body = (yield* res.json) as { listed: Record<string, boolean> };
      expect(body.listed).toEqual({ volumes: true, dicts: true, queues: true, secrets: true });

      // Out of band: each object's Modal name starts with the owner's prefix.
      const name = `${Modal.runtimePrefix({ stack: stack.name, stage: stack.stage, id: "ModalObjectsWorker" })}-tags-t1`;
      const volumes = (yield* volume.listVolume({})).items.filter((v) => v.label === name);
      const dicts = (yield* dict.listDict({})).dicts.filter((d) => d.name === name);
      const queues = (yield* queue.listQueue({})).queues.filter((q) => q.name === name);
      const secrets = (yield* secret.listSecret({})).items.filter((s) => s.label === name);
      expect([volumes.length, dicts.length, queues.length, secrets.length]).toEqual([1, 1, 1, 1]);

      // Destroying the stack leaves them, so the test deletes its own.
      for (const v of volumes) yield* volume.deleteVolume({ volumeId: v.volumeId });
      for (const d of dicts) yield* dict.deleteDict({ dictId: d.dictId });
      for (const q of queues) yield* queue.deleteQueue({ queueId: q.queueId });
      for (const s of secrets) yield* secret.deleteSecret({ secretId: s.secretId });

      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);
