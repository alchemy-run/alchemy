import * as GCP from "@alchemy.run/gcp";
import { makeGcsState } from "@alchemy.run/gcp";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import {
  current,
  deployArgs,
  fails,
  planLine,
  released,
  RELEASED,
  succeeds,
  workdir,
  type RunOptions,
} from "./Harness.ts";
import {
  expectPlaintext,
  expectSealed,
  secretsOfTexts,
  secretsThroughStore,
  STACK,
} from "./Records.ts";

const { test } = Test.make({ providers: GCP.providers() });

const PASSPHRASE = "state upgrade test passphrase";

test.provider(
  `a Cloud Storage store written by ${RELEASED} stays readable, and seals with a layer`,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(GCP.Storage.Bucket("StateBucket", { forceDestroy: true }));
      const media = yield* makeObjectMedia;
      const objectText = (object: string) =>
        media
          .download({ bucket: bucket.bucketName, object })
          .pipe(Effect.map((result) => new TextDecoder().decode(result.body)));
      /** A stage's state objects, by object name. */
      const stageObjects = Effect.gen(function* () {
        const listed = yield* storage.listObjects({
          bucket: bucket.bucketName,
          prefix: `${STACK}/one/`,
        });
        const objects = new Map<string, string>();
        for (const { name } of listed.items ?? []) {
          if (name === undefined || name.endsWith("__lease__.json")) continue;
          objects.set(name, yield* objectText(name));
        }
        return objects;
      });

      const cwd = yield* workdir("gcs");
      const old = yield* released();
      const next = yield* current();
      const on = (overrides: Record<string, string> = {}): RunOptions => ({
        cwd,
        env: { UPGRADE_STORE: "gcs", UPGRADE_GCS_BUCKET: bucket.bucketName, ...overrides },
      });
      const withPassphrase = (encryption: string) =>
        on({ UPGRADE_ENCRYPTION: encryption, ALCHEMY_STATE_PASSPHRASE: PASSPHRASE });

      yield* succeeds(old, deployArgs("one"), on());
      const original = yield* stageObjects;
      expect(original.size).toBe(3);
      const secrets = secretsOfTexts(original.values());

      // Without a layer the new version keeps the objects, and records the
      // store's format beside them; the released version still deploys.
      const upgraded = yield* succeeds(next, deployArgs("one"), on());
      expect(planLine(upgraded)).toBe("Plan: no changes");
      expect(yield* stageObjects).toEqual(original);
      expect(JSON.parse(yield* objectText("__alchemy_store__.json"))).toEqual({ format: 1 });
      const stillOld = yield* succeeds(old, deployArgs("one"), on());
      expect(planLine(stillOld)).toBe("Plan: no changes");

      // A layer seals the stage; the released version then refuses it
      // without writing.
      yield* succeeds(next, deployArgs("one"), withPassphrase("passphrase"));
      const sealed = yield* stageObjects;
      expectSealed(sealed.values(), secrets);
      yield* fails(old, deployArgs("one"), on());
      expect(yield* stageObjects).toEqual(sealed);

      // `disable` opens it again for the released version.
      yield* succeeds(next, deployArgs("one"), withPassphrase("passphrase-disable"));
      const decrypted = yield* stageObjects;
      expectPlaintext(decrypted.values());
      expect(secretsOfTexts(decrypted.values())).toEqual(secrets);
      expect(
        yield* secretsThroughStore(makeGcsState({ bucketName: bucket.bucketName }), "one"),
      ).toEqual(secrets);
      const downgraded = yield* succeeds(old, deployArgs("one"), on());
      expect(planLine(downgraded)).toBe("Plan: no changes");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:gcp", "provider:gcp:storage", "provider:gcp:statestore", "live"],
    timeout: 300_000,
  },
);
