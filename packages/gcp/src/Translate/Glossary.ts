import * as translate from "@distilled.cloud/gcp/translate_v3";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  ResourceNotResolved,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type GlossaryLanguagePair = {
  /** Language of the source terms, for example `"en"`. */
  sourceLanguageCode: string;
  /** Language the terms translate to, for example `"es"`. */
  targetLanguageCode: string;
};

export type GlossaryProps = {
  /**
   * Glossary id (the `{glossary}` segment of
   * `projects/{project}/locations/{location}/glossaries/{glossary}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the glossary.
   */
  glossaryId?: string;
  /**
   * Location of the glossary. Immutable — changing it replaces the glossary.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Cloud Storage URI of the glossary file (`gs://bucket/glossary.tsv`):
   * TSV, CSV or TMX for a `languagePair` glossary, CSV with a language per
   * column for `languageCodes`. Changing it rebuilds the glossary from the
   * new file in place.
   */
  source: string;
  /**
   * Source and target language of a unidirectional glossary. Set this or
   * `languageCodes`. Immutable — changing it replaces the glossary.
   */
  languagePair?: GlossaryLanguagePair;
  /**
   * Languages of an equivalent-term-set glossary, at least two. Set this or
   * `languagePair`. Immutable — changing it replaces the glossary.
   */
  languageCodes?: string[];
  /** Display name. */
  displayName?: string;
};

export type Glossary = Resource<
  "GCP.Translate.Glossary",
  GlossaryProps,
  {
    /** Full name, `projects/{project}/locations/{location}/glossaries/{glossary}`. */
    name: string;
    /** Glossary id (last path segment). */
    glossaryId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Cloud Storage URI the glossary was built from. */
    source: string | undefined;
    /** Source and target language, for a unidirectional glossary. */
    languagePair: GlossaryLanguagePair | undefined;
    /** Languages, for an equivalent-term-set glossary. */
    languageCodes: string[] | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Number of entries built from the file. */
    entryCount: number | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Translation glossary: terms that must translate a fixed way,
 * built from a file in Cloud Storage. `TranslateText` applies it when a
 * request names the glossary, and `GlossariesGlossaryEntry` adds terms to it.
 *
 * Glossaries have no labels, so Alchemy tracks one by the name recorded in
 * state; `read` reports one it finds without prior state as unowned (adopt
 * it with `--adopt`). Create, rebuild and delete are long-running
 * operations. Changing `source` or `displayName` updates the glossary in
 * place; its id, location and languages are fixed.
 *
 * ### Creating a Glossary
 * **Example:** English to Spanish terms from a TSV file
 * ```typescript
 * const terms = yield* GCP.Storage.Bucket("Terms", { location: "US" });
 * const glossary = yield* GCP.Translate.Glossary("Product", {
 *   source: `gs://${terms.bucketName}/glossary.tsv`,
 *   languagePair: { sourceLanguageCode: "en", targetLanguageCode: "es" },
 * });
 * ```
 *
 * **Example:** Equivalent terms across languages
 * ```typescript
 * const glossary = yield* GCP.Translate.Glossary("Brands", {
 *   source: `gs://${terms.bucketName}/brands.csv`,
 *   languageCodes: ["en", "es", "fr"],
 * });
 * ```
 *
 * ### Adding terms
 * **Example:** One more term pair
 * ```typescript
 * yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
 *   parent: glossary.name,
 *   termsPair: {
 *     sourceTerm: { languageCode: "en", text: "hello" },
 *     targetTerm: { languageCode: "es", text: "hola" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Translate
 */
export const Glossary = Resource<Glossary>("GCP.Translate.Glossary");

const resourceName = (project: string, location: string, glossaryId: string) =>
  resourceNameOf(locationParent(project, location), "glossaries", glossaryId);

const toAttrs = (glossary: translate.Glossary, project: string): Glossary["Attributes"] => {
  const name = glossary.name ?? "";
  const parsed = parseResourceName(name, "glossaries");
  const pair = glossary.languagePair;
  return {
    name,
    glossaryId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    source: glossary.inputConfig?.gcsSource?.inputUri,
    languagePair:
      pair?.sourceLanguageCode && pair.targetLanguageCode
        ? {
            sourceLanguageCode: pair.sourceLanguageCode,
            targetLanguageCode: pair.targetLanguageCode,
          }
        : undefined,
    languageCodes: glossary.languageCodesSet?.languageCodes,
    displayName: glossary.displayName,
    entryCount: glossary.entryCount,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.undefined
    : translate
        .getProjectsLocationsGlossaries({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const GlossaryProvider = () =>
  Provider.succeed(Glossary, {
    stables: ["name", "glossaryId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPair = olds?.languagePair ?? output?.languagePair;
      const previousCodes = olds?.languageCodes ?? output?.languageCodes;
      return replaceOnIdentity({
        previousId: olds?.glossaryId ?? output?.glossaryId,
        nextId: news.glossaryId ?? olds?.glossaryId ?? output?.glossaryId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra:
          (previousPair !== undefined && !sameJson(previousPair, news.languagePair)) ||
          (previousCodes !== undefined && !sameJson(previousCodes, news.languageCodes)),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const glossaryId = olds?.glossaryId ?? output?.glossaryId;
      const name =
        output?.name ?? (glossaryId ? resourceName(env.project, location, glossaryId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location ?? DEFAULT_LOCATION);
      const glossaryId = yield* toPhysicalId(id, news.glossaryId, output?.glossaryId);
      const name = output?.name ?? resourceName(env.project, location, glossaryId);
      const inputConfig = { gcsSource: { inputUri: news.source } };

      // Observe
      let current = yield* getByName(name);

      // Ensure
      if (current === undefined) {
        const operation = yield* retryTransient(
          translate.createProjectsLocationsGlossaries({
            parent: locationParent(env.project, location),
            body: {
              name,
              displayName: news.displayName,
              inputConfig,
              languagePair: news.languagePair,
              languageCodesSet: news.languageCodes
                ? { languageCodes: news.languageCodes }
                : undefined,
            },
          }),
        );
        yield* waitForOperation(operation);
        current = yield* getByName(name);
      }

      // Sync: the file and display name are the only mutable fields. Create
      // ignores `displayName`, so a new glossary is patched here too.
      if (current !== undefined) {
        const mask = [
          ...(sameText(current.inputConfig?.gcsSource?.inputUri, news.source)
            ? []
            : ["input_config"]),
          ...(news.displayName === undefined || sameText(current.displayName, news.displayName)
            ? []
            : ["display_name"]),
        ];
        if (mask.length > 0) {
          const operation = yield* retryTransient(
            translate.patchProjectsLocationsGlossaries({
              name,
              updateMask: mask.join(","),
              body: { name, displayName: news.displayName, inputConfig },
            }),
          );
          // Translate can drop a patch's operation record before a poll
          // reaches it (NotFound): wait on the glossary itself instead.
          yield* waitForOperation(operation, { notFoundOk: true });
          current = yield* getByName(name).pipe(
            Effect.filterOrFail(
              (glossary) =>
                glossary !== undefined &&
                sameText(glossary.inputConfig?.gcsSource?.inputUri, news.source) &&
                (news.displayName === undefined ||
                  sameText(glossary.displayName, news.displayName)),
              () => new ResourceNotResolved({ resourceName: name }),
            ),
            Effect.retry({
              while: (error) => error._tag === "GCP.Translate.ResourceNotResolved",
              schedule: Schedule.spaced("5 seconds"),
              times: 36,
            }),
          );
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ resourceName: name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* retryTransient(
        translate.deleteProjectsLocationsGlossaries({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
