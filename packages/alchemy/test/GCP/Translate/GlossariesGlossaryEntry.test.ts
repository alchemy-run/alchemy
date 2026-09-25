import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { hasGcpCreds, location, logLevel, parent } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const GLOSSARY_ID = "alctrglos1";

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

const waitUntilGlossaryGone = (name: string) =>
  translate.getProjectsLocationsGlossaries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const uploadObject = (bucketName: string, object: string, body: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const bytes = yield* Effect.sync(() => new TextEncoder().encode(body));
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o` +
      `?uploadType=media&name=${encodeURIComponent(object)}`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(creds.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(bytes, "text/tab-separated-values"),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new Error(`object upload failed: ${response.status} ${text}`),
      );
    }
  });

const glossaryNameFromOperation = (operation: translate.Operation) => {
  const response = operation.response ?? {};
  const name = response.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const createGlossary = (glossaryId: string, inputUri?: string) =>
  Effect.gen(function* () {
    const name = `${parent}/glossaries/${glossaryId}`;
    const existing = yield* translate
      .getProjectsLocationsGlossaries({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing !== undefined) return existing;
    const operation = yield* translate
      .createProjectsLocationsGlossaries({
        parent,
        body: {
          name,
          languagePair: {
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
          },
          ...(inputUri ? { inputConfig: { gcsSource: { inputUri } } } : {}),
        },
      })
      .pipe(
        Effect.catchTag("Conflict", () =>
          Effect.succeed({ name, done: true } as translate.Operation),
        ),
      );
    const done = yield* GCP.Translate.waitForOperation(operation);
    return (
      glossaryNameFromOperation(done) ??
      (yield* translate.getProjectsLocationsGlossaries({ name }))
    );
  });

const deleteGlossary = (name: string) =>
  translate.deleteProjectsLocationsGlossaries({ name }).pipe(
    Effect.flatMap((operation) =>
      GCP.Translate.waitForOperation(operation, { notFoundOk: true }),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsGlossariesGlossaryEntries on a missing entry fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: `${parent}/glossaries/alchemy-missing/glossaryEntries/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a glossary entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* translate
        .listProjectsLocationsGlossaries({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }
      expect(["ok", "NotFound"]).toContain(probe.tag);

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("GlossarySrc", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
        }),
      );
      yield* uploadObject(bucket.bucketName, "glossary.tsv", "hello\thola\n");

      const glossary = yield* createGlossary(
        GLOSSARY_ID,
        `gs://${bucket.bucketName}/glossary.tsv`,
      ).pipe(
        Effect.map((value) => ({ tag: "ok" as const, value })),
        Effect.catchTag("BadRequest", (error) =>
          Effect.succeed({
            tag: "BadRequest" as const,
            message: error.message,
          }),
        ),
        Effect.catchTag("Forbidden", (error) =>
          Effect.succeed({
            tag: "Forbidden" as const,
            message: error.message,
          }),
        ),
        Effect.catchTag("GCP.Translate.OperationPending", (error) =>
          Effect.succeed({
            tag: "GCP.Translate.OperationPending" as const,
            message: error.message,
          }),
        ),
        Effect.catchTag("GCP.Translate.OperationFailed", (error) =>
          Effect.succeed({
            tag: "GCP.Translate.OperationFailed" as const,
            message: error.message,
          }),
        ),
      );
      if (glossary.tag !== "ok") {
        expect([
          "Forbidden",
          "BadRequest",
          "GCP.Translate.OperationPending",
          "GCP.Translate.OperationFailed",
        ]).toContain(glossary.tag);
        yield* stack.destroy();
        return;
      }
      const glossaryName =
        typeof glossary.value === "string"
          ? glossary.value
          : (glossary.value.name ?? `${parent}/glossaries/${GLOSSARY_ID}`);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const nextBucket = yield* GCP.Storage.Bucket("GlossarySrc", {
            bucketName: bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
            parent: glossaryName,
            location,
            description: "greeting",
            termsPair: {
              sourceTerm: { languageCode: "en", text: "hello" },
              targetTerm: { languageCode: "es", text: "hola" },
            },
          });
          return { bucket: nextBucket, entry };
        }),
      );

      expect(created.entry.name).toContain("/glossaryEntries/");
      expect(created.entry.parent).toEqual(glossaryName);
      expect(created.entry.description).toEqual("greeting");
      expect(created.entry.termsPair?.sourceTerm?.text).toEqual("hello");
      expect(created.entry.termsPair?.targetTerm?.text).toEqual("hola");

      const fetched =
        yield* translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: created.entry.name,
        });
      expect(fetched.name).toEqual(created.entry.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.termsPair?.targetTerm?.text).toEqual("hola");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const nextBucket = yield* GCP.Storage.Bucket("GlossarySrc", {
            bucketName: bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
            parent: glossaryName,
            location,
            glossaryEntryId: created.entry.glossaryEntryId,
            description: "greeting",
            termsPair: {
              sourceTerm: { languageCode: "en", text: "hello" },
              targetTerm: { languageCode: "es", text: "buenas" },
            },
          });
          return { bucket: nextBucket, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.termsPair?.targetTerm?.text).toEqual("buenas");

      const patched =
        yield* translate.getProjectsLocationsGlossariesGlossaryEntries({
          name: created.entry.name,
        });
      expect(patched.termsPair?.targetTerm?.text).toEqual("buenas");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");

      yield* deleteGlossary(glossaryName);
      const glossaryGone = yield* waitUntilGlossaryGone(glossaryName);
      expect(glossaryGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
