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
  expandParent,
  findOwnedByDisplayName,
  hasOwnershipMarker,
  listModelsAt,
  listProjectModels,
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
import { waitForOperation } from "./operations.ts";

export type ModelProps = {
  /**
   * Model id (the `{model}` segment of
   * `projects/{project}/locations/{location}/models/{model}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the model.
   */
  modelId?: string;
  /**
   * Location of the model (`us-central1`, `europe-west1`, …). Custom
   * AutoML Translation models are regional. Immutable — changing it
   * replaces the model.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Training dataset resource name
   * `projects/{project}/locations/{location}/datasets/{dataset}` or the
   * dataset id (combined with `location`). Immutable — changing it
   * replaces the model.
   */
  dataset: string;
  /**
   * User-facing display name. Custom models have no labels field and
   * display names may only use A-Z, a-z, 0-9, and underscore (max 32
   * characters), so Alchemy packs ownership as `alc_{stack}_{stage}_{id}`
   * and strips it from attributes. There is no update API — changing
   * display name replaces the model.
   */
  displayName?: string;
};

export type Model = Resource<
  "GCP.Translate.Model",
  ModelProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/models/{model}`. */
    name: string;
    /** Model id (last path segment). */
    modelId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Training dataset resource name. */
    dataset: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** BCP-47 source language copied from the dataset. */
    sourceLanguageCode: string | undefined;
    /** BCP-47 target language copied from the dataset. */
    targetLanguageCode: string | undefined;
    /** Number of sentence pairs used to train the model. */
    trainExampleCount: number | undefined;
    /** Number of sentence pairs used to validate the model. */
    validateExampleCount: number | undefined;
    /** Number of sentence pairs used to test the model. */
    testExampleCount: number | undefined;
    /** RFC3339 creation timestamp (also when training started). */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A trained Cloud Translation AutoML model.
 *
 * Models are trained from a Translation dataset in the same location.
 * Create and delete are long-running operations. Models have no labels
 * field, so Alchemy stamps ownership into `displayName` for `list` /
 * nuke. Dataset, location, and display name are immutable — there is
 * no patch RPC. Training can take hours; tests skipIf-gate behind
 * `FAST`.
 *
 * ### Creating a Model
 * **Example:** Train from a dataset
 * ```typescript
 * const model = yield* GCP.Translate.Model("EnEs", {
 *   dataset: dataset.name,
 *   displayName: "enes",
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const model = yield* GCP.Translate.Model("EnEs", {
 *   modelId: "en-es-custom",
 *   location: "us-central1",
 *   dataset: dataset.name,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Translate
 */
export const Model = Resource<Model>("GCP.Translate.Model");

const resourceName = (project: string, location: string, modelId: string) =>
  resourceNameOf(locationParent(project, location), "models", modelId);

const datasetNameOf = (project: string, location: string, dataset: string) =>
  expandParent(dataset, project, location, "datasets");

const toAttrs = (model: translate.Model, project: string) => {
  const name = model.name ?? "";
  const parsed = parseResourceName(name, "models");
  const ownership = parseOwnership(model.displayName);
  return {
    name,
    modelId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    dataset: model.dataset,
    displayName: ownership.text,
    sourceLanguageCode: model.sourceLanguageCode,
    targetLanguageCode: model.targetLanguageCode,
    trainExampleCount: model.trainExampleCount,
    validateExampleCount: model.validateExampleCount,
    testExampleCount: model.testExampleCount,
    createTime: model.createTime,
    updateTime: model.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : translate
        .getProjectsLocationsModels({ name })
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
      yield* listModelsAt(parent),
    );
    if (local !== undefined) return local;
    return yield* findOwnedByDisplayName(id, yield* listProjectModels(project));
  });

export const ModelProvider = () =>
  Provider.succeed(Model, {
    stables: ["name", "modelId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousDataset = olds?.dataset ?? output?.dataset;
      const extra =
        (previousDataset !== undefined &&
          news.dataset !== previousDataset &&
          !news.dataset.endsWith(`/${previousDataset}`) &&
          !(previousDataset ?? "").endsWith(`/${news.dataset}`)) ||
        (news.displayName !== undefined &&
          (olds?.displayName ?? output?.displayName) !== undefined &&
          news.displayName !== (olds?.displayName ?? output?.displayName));
      return replaceOnIdentity({
        previousId: olds?.modelId ?? output?.modelId,
        nextId: news.modelId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const modelId = olds?.modelId ?? output?.modelId;
      const name =
        output?.name ??
        (modelId ? resourceName(env.project, location, modelId) : "");
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
        const models = yield* listProjectModels(env.project);
        return models
          .filter((model) => hasOwnershipMarker(model.displayName))
          .map((model) => toAttrs(model, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const modelId = yield* toPhysicalId(id, news.modelId, output?.modelId);
      const name = resourceName(env.project, location, modelId);
      const dataset = datasetNameOf(env.project, location, news.dataset);
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
          translate.createProjectsLocationsModels({
            parent,
            body: {
              name,
              displayName,
              dataset,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            findOwned(id, env.project, parent, name),
          ),
        );
        if (created && "done" in created) {
          yield* waitForOperation(created);
          current = yield* findOwned(id, env.project, parent, name);
        } else {
          current = created ?? undefined;
        }
      }

      if (current === undefined) {
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: hinted || name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* retryTransient(
        translate.deleteProjectsLocationsModels({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined && "done" in operation) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
