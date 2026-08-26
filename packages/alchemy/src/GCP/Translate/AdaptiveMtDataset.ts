import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  MAX_DISPLAY_NAME_LENGTH,
  ResourceNotResolved,
  encodeRestrictedDisplayName,
  findOwnedByDisplayName,
  hasOwnershipMarker,
  listAdaptiveMtDatasetsAt,
  listProjectAdaptiveMtDatasets,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  retryTransient,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";

export type AdaptiveMtDatasetProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/locations/{location}/adaptiveMtDatasets/{dataset}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the dataset.
   */
  datasetId?: string;
  /**
   * Location of the dataset (`us-central1`, `europe-west1`, …). Adaptive
   * MT is regional. Immutable — changing it replaces the dataset.
   * @default "us-central1"
   */
  location?: string;
  /**
   * User-facing display name. Adaptive MT datasets have no labels field
   * and display names may only use A-Z, a-z, 0-9, and underscore (max
   * 32 characters), so Alchemy packs ownership as `alc_{stack}_{stage}_{id}`
   * and strips it from attributes. There is no update API — changing
   * display name replaces the dataset.
   */
  displayName?: string;
  /**
   * BCP-47 source language code, for example `"en"`. Immutable —
   * changing it replaces the dataset.
   */
  sourceLanguageCode: string;
  /**
   * BCP-47 target language code, for example `"es"`. Immutable —
   * changing it replaces the dataset.
   */
  targetLanguageCode: string;
};

export type AdaptiveMtDataset = Resource<
  "GCP.Translate.AdaptiveMtDataset",
  AdaptiveMtDatasetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/adaptiveMtDatasets/{dataset}`. */
    name: string;
    /** Dataset id (last path segment). */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** BCP-47 source language code. */
    sourceLanguageCode: string | undefined;
    /** BCP-47 target language code. */
    targetLanguageCode: string | undefined;
    /** Number of imported sentence pairs. */
    exampleCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Adaptive MT dataset of source/target sentence pairs used to
 * customize Cloud Translation.
 *
 * Adaptive MT datasets are location-scoped and have no labels field.
 * Alchemy stamps ownership into `displayName` (restricted charset) for
 * `list` / nuke. Language pair, location, and display name are
 * immutable — there is no patch RPC.
 *
 * ### Creating a Dataset
 * **Example:** English to Spanish
 * ```typescript
 * const dataset = yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
 *   sourceLanguageCode: "en",
 *   targetLanguageCode: "es",
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const dataset = yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
 *   datasetId: "en-es-adaptive",
 *   location: "us-central1",
 *   sourceLanguageCode: "en",
 *   targetLanguageCode: "es",
 *   displayName: "enes",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Translate
 */
export const AdaptiveMtDataset = Resource<AdaptiveMtDataset>(
  "GCP.Translate.AdaptiveMtDataset",
);

const resourceName = (project: string, location: string, datasetId: string) =>
  resourceNameOf(
    locationParent(project, location),
    "adaptiveMtDatasets",
    datasetId,
  );

const toAttrs = (dataset: translate.AdaptiveMtDataset, project: string) => {
  const name = dataset.name ?? "";
  const parsed = parseResourceName(name, "adaptiveMtDatasets");
  const ownership = parseOwnership(dataset.displayName);
  return {
    name,
    datasetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    sourceLanguageCode: dataset.sourceLanguageCode,
    targetLanguageCode: dataset.targetLanguageCode,
    exampleCount: dataset.exampleCount,
    createTime: dataset.createTime,
    updateTime: dataset.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : translate
        .getProjectsLocationsAdaptiveMtDatasets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  id: string,
  project: string,
  parent: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const local = yield* findOwnedByDisplayName(
      id,
      yield* listAdaptiveMtDatasetsAt(parent),
    );
    if (local !== undefined) return local;
    return yield* findOwnedByDisplayName(
      id,
      yield* listProjectAdaptiveMtDatasets(project),
    );
  });

export const AdaptiveMtDatasetProvider = () =>
  Provider.succeed(AdaptiveMtDataset, {
    stables: ["name", "datasetId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const extra =
        (olds?.sourceLanguageCode !== undefined &&
          news.sourceLanguageCode !== olds.sourceLanguageCode) ||
        (output?.sourceLanguageCode !== undefined &&
          news.sourceLanguageCode !== output.sourceLanguageCode) ||
        (olds?.targetLanguageCode !== undefined &&
          news.targetLanguageCode !== olds.targetLanguageCode) ||
        (output?.targetLanguageCode !== undefined &&
          news.targetLanguageCode !== output.targetLanguageCode) ||
        (news.displayName !== undefined &&
          (olds?.displayName ?? output?.displayName) !== undefined &&
          news.displayName !== (olds?.displayName ?? output?.displayName));
      return replaceOnIdentity({
        previousId: olds?.datasetId ?? output?.datasetId,
        nextId: news.datasetId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const datasetId = olds?.datasetId ?? output?.datasetId;
      const name =
        output?.name ??
        (datasetId ? resourceName(env.project, location, datasetId) : "");
      const parent = locationParent(env.project, location);
      const existing = yield* findOwned(id, env.project, parent, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* listProjectAdaptiveMtDatasets(env.project);
        return datasets
          .filter((dataset) => hasOwnershipMarker(dataset.displayName))
          .map((dataset) => toAttrs(dataset, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const datasetId = yield* toPhysicalId(
        id,
        news.datasetId,
        output?.datasetId,
      );
      const name = resourceName(env.project, location, datasetId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeRestrictedDisplayName(
        ownership,
        news.displayName ?? output?.displayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const hinted = output?.name ?? name;

      let current = yield* findOwned(id, env.project, parent, hinted);

      if (current === undefined) {
        const created = yield* retryTransient(
          translate.createProjectsLocationsAdaptiveMtDatasets({
            parent,
            body: {
              name,
              displayName,
              sourceLanguageCode: news.sourceLanguageCode,
              targetLanguageCode: news.targetLanguageCode,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            findOwned(id, env.project, parent, name),
          ),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: hinted || name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        translate.deleteProjectsLocationsAdaptiveMtDatasets({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
