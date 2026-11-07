import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentParent } from "./common.ts";
import { EnEsGlossary } from "./fixtures/glossary.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsGlossariesGlossaryEntries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const entry = (target: string, glossaryEntryId?: string) =>
  Effect.gen(function* () {
    const glossary = yield* EnEsGlossary;
    const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
      parent: glossary.name,
      location,
      glossaryEntryId,
      description: "greeting",
      termsPair: {
        sourceTerm: { languageCode: "en", text: "hello" },
        targetTerm: { languageCode: "es", text: target },
      },
    });
    return { glossary, entry };
  });

test.provider(
  "getProjectsLocationsGlossariesGlossaryEntries on a missing entry fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* currentParent;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: `${parent}/glossaries/alchemy-missing/glossaryEntries/123`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:translate", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a glossary entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(entry("hola"));

      expect(created.entry.name).toContain("/glossaryEntries/");
      expect(created.entry.parent).toEqual(created.glossary.name);
      expect(created.entry.description).toEqual("greeting");
      expect(created.entry.termsPair?.sourceTerm?.text).toEqual("hello");
      expect(created.entry.termsPair?.targetTerm?.text).toEqual("hola");

      const fetched = yield* translate.getProjectsLocationsGlossariesGlossaryEntries({
        name: created.entry.name,
      });
      expect(fetched.name).toEqual(created.entry.name);
      expect(fetched.description).toEqual("greeting");
      expect(fetched.termsPair?.targetTerm?.text).toEqual("hola");

      const updated = yield* stack.deploy(entry("buenas", created.entry.glossaryEntryId));

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.termsPair?.targetTerm?.text).toEqual("buenas");

      const patched = yield* translate.getProjectsLocationsGlossariesGlossaryEntries({
        name: created.entry.name,
      });
      expect(patched.termsPair?.targetTerm?.text).toEqual("buenas");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:translate", "live"],
    timeout: 600_000,
  },
);
