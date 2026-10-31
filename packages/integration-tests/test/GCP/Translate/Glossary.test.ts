import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentParent } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsGlossaries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/** A glossary built from `key` in its own bucket; both term files exist. */
const glossary = (key: "v1.tsv" | "v2.tsv", displayName: string) =>
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.Bucket("Terms", {
      location: "US-CENTRAL1",
      forceDestroy: true,
    });
    const v1 = yield* GCP.Storage.Object("TermsV1", {
      bucketName: bucket.bucketName,
      key: "v1.tsv",
      content: "hello\thola\n",
    });
    const v2 = yield* GCP.Storage.Object("TermsV2", {
      bucketName: bucket.bucketName,
      key: "v2.tsv",
      content: "hello\thola\ngoodbye\tadiós\n",
    });
    const file = key === "v1.tsv" ? v1 : v2;
    return yield* GCP.Translate.Glossary("EnEs", {
      source: Output.interpolate`gs://${file.bucketName}/${file.key}`,
      languagePair: { sourceLanguageCode: "en", targetLanguageCode: "es" },
      displayName,
    });
  });

test.provider(
  "getProjectsLocationsGlossaries on a missing glossary fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsGlossaries({
          name: `${parent}/glossaries/alchemy-missing-glossary`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:translate", "live"], timeout: 90_000 },
);

test.provider(
  "create, rebuild from a new file, rename, and delete a glossary",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(glossary("v1.tsv", "terms"));
      expect(created.name).toContain("/glossaries/");
      expect(created.source).toMatch(/\/v1\.tsv$/);
      expect(created.languagePair).toEqual({
        sourceLanguageCode: "en",
        targetLanguageCode: "es",
      });
      expect(created.entryCount).toEqual(1);

      const fetched = yield* translate.getProjectsLocationsGlossaries({ name: created.name });
      expect(fetched.displayName).toEqual("terms");
      expect(fetched.entryCount).toEqual(1);

      // A new file and display name update the glossary in place.
      const updated = yield* stack.deploy(glossary("v2.tsv", "terms v2"));
      expect(updated.name).toEqual(created.name);
      expect(updated.source).toMatch(/\/v2\.tsv$/);
      expect(updated.entryCount).toEqual(2);

      const refetched = yield* translate.getProjectsLocationsGlossaries({ name: created.name });
      expect(refetched.displayName).toEqual("terms v2");
      expect(refetched.inputConfig?.gcsSource?.inputUri).toMatch(/\/v2\.tsv$/);
      expect(refetched.entryCount).toEqual(2);

      // Redeploying the same props changes nothing.
      const plan = yield* stack.plan(glossary("v2.tsv", "terms v2"));
      expect(plan.resources.EnEs?.action).toEqual("noop");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:translate", "live"],
    timeout: 900_000,
  },
);
