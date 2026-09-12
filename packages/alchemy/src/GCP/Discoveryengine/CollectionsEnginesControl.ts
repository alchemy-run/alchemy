import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  listEngines,
  ownershipLabels,
  parentBefore,
  parseOwnership,
  parseResourceName,
  sameJson,
  sameStringList,
  toResourceId,
} from "./internal.ts";

export type CollectionsEnginesControlProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the control.
   */
  engine: string;
  /**
   * Control id (1-63 characters, `a-z`, `_`, `-`). If omitted, a unique
   * id is generated. Immutable — changing it replaces the control.
   */
  controlId?: string;
  /**
   * Human-readable name. Controls have no labels field, so Alchemy
   * stamps ownership into this field for list / nuke.
   */
  displayName?: string;
  /**
   * Solution the control belongs to. Immutable.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?: discoveryengine.GoogleCloudDiscoveryengineV1ControlSolutionTypeEnum;
  /**
   * Use cases. Required when `solutionType` is `SOLUTION_TYPE_SEARCH`.
   * @default ["SEARCH_USE_CASE_SEARCH"]
   */
  useCases?: discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList;
  /**
   * Conditions that must match before the action runs.
   */
  conditions?: discoveryengine.GoogleCloudDiscoveryengineV1ConditionList;
  /**
   * Redirect-type action.
   */
  redirectAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlRedirectAction;
  /**
   * Filter-type action.
   */
  filterAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlFilterAction;
  /**
   * Synonyms-type action.
   */
  synonymsAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlSynonymsAction;
  /**
   * Boost-type action.
   */
  boostAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlBoostAction;
  /**
   * Promote-type action.
   */
  promoteAction?: discoveryengine.GoogleCloudDiscoveryengineV1ControlPromoteAction;
};

export type CollectionsEnginesControl = Resource<
  "GCP.Discoveryengine.CollectionsEnginesControl",
  CollectionsEnginesControlProps,
  {
    /** Full resource name. */
    name: string;
    /** Control id (last path segment). */
    controlId: string;
    /** Parent engine resource name. */
    engine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Solution type. */
    solutionType: string | undefined;
    /** Use cases. */
    useCases: string[];
    /** Serving configs this control is attached to. */
    associatedServingConfigIds: string[];
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Control on a collection Engine — redirects,
 * filters, synonyms, boosts, or promotions applied at serving time.
 *
 * Controls have no labels, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent engine, control id, and
 * solution type are immutable; display name, conditions, and actions
 * update in place.
 *
 * ### Creating a Control
 * **Example:** Synonym control
 * ```typescript
 * const control = yield* GCP.Discoveryengine.CollectionsEnginesControl(
 *   "Synonyms",
 *   {
 *     engine: engine.name,
 *     displayName: "hello-hi",
 *     synonymsAction: { synonyms: ["hello", "hi"] },
 *   },
 * );
 * ```
 *
 * ### Updating a Control
 * **Example:** Change synonyms
 * ```typescript
 * const control = yield* GCP.Discoveryengine.CollectionsEnginesControl(
 *   "Synonyms",
 *   {
 *     engine: existing.engine,
 *     controlId: existing.controlId,
 *     synonymsAction: { synonyms: ["hello", "hi", "hey"] },
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsEnginesControl = Resource<CollectionsEnginesControl>(
  "GCP.Discoveryengine.CollectionsEnginesControl",
);

export class CollectionsEnginesControlNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsEnginesControlNotResolved",
)<{
  name: string;
}> {}

const resourceName = (engine: string, controlId: string) =>
  `${engine}/controls/${controlId}`;

const solutionOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1ControlSolutionTypeEnum
    | undefined,
) => value ?? "SOLUTION_TYPE_SEARCH";

const useCasesOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList
    | undefined,
  solutionType: string,
):
  | discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList
  | undefined => {
  if (value && value.length > 0) return value;
  if (solutionType === "SOLUTION_TYPE_SEARCH") {
    return ["SEARCH_USE_CASE_SEARCH"];
  }
  return undefined;
};

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesControls({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listByEngine = (engine: string) =>
  discoveryengine.listProjectsLocationsCollectionsEnginesControls
    .pages({ parent: engine, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.controls ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const toAttrs = (
  control: discoveryengine.GoogleCloudDiscoveryengineV1Control,
  project: string,
) => {
  const name = control.name ?? "";
  const parsed = parseResourceName(name, "controls");
  const ownership = parseOwnership(control.displayName);
  return {
    name,
    controlId: parsed.id,
    engine: parentBefore(name, "controls"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    displayName: ownership.text,
    solutionType: control.solutionType,
    useCases: [...(control.useCases ?? [])],
    associatedServingConfigIds: [...(control.associatedServingConfigIds ?? [])],
  };
};

const findOwned = (id: string, engine: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const items = yield* listByEngine(engine);
    for (const item of items) {
      const { labels } = parseOwnership(item.displayName);
      if (yield* hasAlchemyLabels(id, labels)) return item;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Control
      | undefined;
  });

const bodyOf = (
  news: CollectionsEnginesControlProps,
  displayName: string,
  solutionType: discoveryengine.GoogleCloudDiscoveryengineV1ControlSolutionTypeEnum,
  useCases:
    | discoveryengine.GoogleCloudDiscoveryengineV1ControlUseCasesItemEnumList
    | undefined,
): discoveryengine.GoogleCloudDiscoveryengineV1Control => ({
  displayName,
  solutionType,
  useCases,
  conditions: news.conditions,
  redirectAction: news.redirectAction,
  filterAction: news.filterAction,
  synonymsAction: news.synonymsAction,
  boostAction: news.boostAction,
  promoteAction: news.promoteAction,
});

export const CollectionsEnginesControlProvider = () =>
  Provider.succeed(CollectionsEnginesControl, {
    stables: [
      "name",
      "controlId",
      "engine",
      "project",
      "location",
      "collectionId",
      "solutionType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      const previousId = olds?.controlId ?? output?.controlId;
      const nextId = news.controlId ?? previousId;
      const previousSolution = solutionOf(
        olds?.solutionType ??
          (output?.solutionType as CollectionsEnginesControlProps["solutionType"]),
      );
      const nextSolution = solutionOf(
        news.solutionType ??
          (output?.solutionType as CollectionsEnginesControlProps["solutionType"]),
      );
      if (
        (previousEngine !== undefined && news.engine !== previousEngine) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousSolution !== nextSolution
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const engine = olds?.engine ?? output?.engine;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : engine !== undefined
            ? yield* findOwned(id, engine)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = yield* listEngines(env.project);
        const rows: ReturnType<typeof toAttrs>[] = [];
        for (const engine of engines) {
          if (engine.name === undefined) continue;
          const items = yield* listByEngine(engine.name);
          for (const item of items) {
            if (hasOwnershipMarker(item.displayName)) {
              rows.push(toAttrs(item, env.project));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const controlId = yield* toResourceId(
        id,
        news.controlId,
        output?.controlId,
      );
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnership(ownership, news.displayName);
      const solutionType = solutionOf(news.solutionType);
      const useCases = useCasesOf(news.useCases, solutionType);
      const fallbackName = output?.name ?? resourceName(news.engine, controlId);
      const desired = bodyOf(news, displayName, solutionType, useCases);

      let current = yield* findOwned(id, news.engine, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesControls({
            parent: news.engine,
            controlId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(fallbackName)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* findOwned(id, news.engine);
        }
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesControlNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const useCasesChanged = !sameStringList(current.useCases, useCases);
      const conditionsChanged = !sameJson(current.conditions, news.conditions);
      const redirectChanged = !sameJson(
        current.redirectAction,
        news.redirectAction,
      );
      const filterChanged = !sameJson(current.filterAction, news.filterAction);
      const synonymsChanged = !sameJson(
        current.synonymsAction,
        news.synonymsAction,
      );
      const boostChanged = !sameJson(current.boostAction, news.boostAction);
      const promoteChanged = !sameJson(
        current.promoteAction,
        news.promoteAction,
      );

      if (
        displayNameChanged ||
        useCasesChanged ||
        conditionsChanged ||
        redirectChanged ||
        filterChanged ||
        synonymsChanged ||
        boostChanged ||
        promoteChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesControls(
            {
              name,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                useCasesChanged ? "use_cases" : undefined,
                conditionsChanged ? "conditions" : undefined,
                redirectChanged ? "redirect_action" : undefined,
                filterChanged ? "filter_action" : undefined,
                synonymsChanged ? "synonyms_action" : undefined,
                boostChanged ? "boost_action" : undefined,
                promoteChanged ? "promote_action" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: { name, ...desired },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesControls({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
