import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import { lookupDict } from "@alchemy.run/modal/Dict";
import { lookupVolume } from "@alchemy.run/modal/Volume";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dict from "@distilled.cloud/modal/dict";
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
  "objects a runtime creates are deleted with the stack, unless retained",
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
        .get(`${url}?key=o1`)
        .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
      const created = (yield* res.json) as { volume: string; dict: string; listed: boolean };
      // Names are stamped with the runtime's prefix; `list` strips it.
      expect(created.volume).not.toBe("objects-o1");
      expect(created.volume.endsWith("-objects-o1")).toBe(true);
      expect(created.listed).toBe(true);

      yield* stack.destroy();

      const getVolume = yield* volume.volumeGetOrCreate;
      const getDict = yield* dict.dictGetOrCreate;
      expect(yield* lookupVolume(getVolume, created.volume, undefined)).toBeUndefined();
      const retained = yield* lookupDict(getDict, created.dict, undefined);
      expect(retained?.dictId).toBeDefined();
      // The retained dict is the test's to clean up.
      yield* dict.deleteDict({ dictId: retained!.dictId });
    }),
  { tags, timeout: 300_000 },
);
