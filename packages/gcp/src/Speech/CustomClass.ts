import * as speech from "@distilled.cloud/gcp/speech_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";
import { inLookupProject } from "../internal/Lookup.ts";
import type { Providers } from "../Providers.ts";
import {
  type ClassItem,
  DEFAULT_LOCATION,
  deleteCustomClass,
  getCustomClass,
  listOwnedCustomClasses,
  locationParent,
  markerFromItems,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  sameItems,
  stripOwnershipItems,
  toPhysicalId,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type { ClassItem };

export type CustomClassProps = {
  /**
   * Speech-to-Text Adaptation location. The global Speech endpoint
   * accepts `global`; `us` and `eu` need matching regional endpoints.
   * Immutable — changing it replaces the custom class.
   * @default "global"
   */
  location?: string;
  /**
   * Custom class id (the `{custom_class}` segment of
   * `projects/{project}/locations/{location}/customClasses/{custom_class}`).
   * If omitted, a unique id is generated. Letters, numbers, and hyphens;
   * 4-63 characters; must start with a letter. Immutable — changing it
   * replaces the custom class.
   */
  customClassId?: string;
  /**
   * Class items (words or phrases that represent one concept).
   */
  items?: ClassItem[];
};

export type CustomClass = Resource<
  "GCP.Speech.CustomClass",
  CustomClassProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/customClasses/{custom_class}`. */
    name: string;
    /** Custom class id (last path segment). */
    customClassId: string;
    /** Project id. */
    project: string;
    /** Adaptation location. */
    location: string;
    /** Class items. */
    items: ClassItem[];
    /** Server-assigned uid, if present. */
    uid: string | undefined;
    /** Lifecycle state, if present. */
    state: string | undefined;
    /** KMS key encrypting class items, if any. */
    kmsKeyName: string | undefined;
  },
  never,
  Providers,
  CustomClassLookup
>;

/**
 * Props for {@link CustomClass.lookup}: find a custom class this stack
 * doesn't manage by its identifiers, in the ambient project unless
 * `project` names another.
 */
export interface CustomClassLookup {
  /**
   * Custom class id (the `{custom_class}` segment of
   * `projects/{project}/locations/{location}/customClasses/{custom_class}`).
   * Letters, numbers, and hyphens; 4-63 characters; must start with a
   * letter.
   */
  customClassId: string;
  /**
   * Speech-to-Text Adaptation location. The global Speech endpoint accepts
   * `global`; `us` and `eu` need matching regional endpoints.
   */
  location?: string;
  /**
   * Project the resource lives in.
   * @default the ambient GCP project
   */
  project?: string;
}

/**
 * A Speech-to-Text Adaptation custom class. Custom classes group words
 * that represent one concept (for example passenger ship names) and are
 * referenced from PhraseSet hints as `${custom_class_id}`.
 *
 * Speech-to-Text v1 classes have no labels field and Alchemy does not
 * write ownership into the items (they steer recognition). A generated id
 * identifies the class; one with an explicit id that Alchemy has no state
 * for is reported as unowned. Location and custom class id are identity — changing either replaces the class.
 * `items` update in place.
 *
 * ### Creating a Custom Class
 * **Example:** Generated id
 * ```typescript
 * const ships = yield* GCP.Speech.CustomClass("Ships", {
 *   items: [{ value: "sloop" }, { value: "ketch" }],
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const ships = yield* GCP.Speech.CustomClass("Ships", {
 *   location: "global",
 *   customClassId: "passenger-ships",
 *   items: [{ value: "sloop" }],
 * });
 * ```
 *
 * ### Updating a Custom Class
 * **Example:** Replace the class items
 * ```typescript
 * const ships = yield* GCP.Speech.CustomClass("Ships", {
 *   items: [{ value: "brig" }, { value: "barque" }],
 * });
 * ```
 *
 * ### Looking up an existing custom class
 * `CustomClass.lookup` references a custom class Alchemy doesn't manage
 * (created in the console or by another stack). It is read during
 * plan/deploy, never created, updated or deleted, and binds like a declared
 * custom class.
 *
 * **Example:** Reference an existing custom class
 * ```typescript
 * const customClass = GCP.Speech.CustomClass.lookup({
 *   customClassId: "my-custom-class",
 * });
 * ```
 *
 * @resource
 * @category Speech
 */
export const CustomClass = Resource<CustomClass>("GCP.Speech.CustomClass");

export class CustomClassNotResolved extends Data.TaggedError("GCP.Speech.CustomClassNotResolved")<{
  resourceName: string;
}> {}

const customClassNameOf = (project: string, location: string, customClassId: string) =>
  resourceNameOf(project, location, "customClasses", customClassId);

const toAttrs = (customClass: speech.CustomClass, project: string) => {
  const name = customClass.name ?? "";
  const parsed = parseResourceName(name, "customClasses");
  return {
    name,
    customClassId: parsed.id || customClass.customClassId || "",
    // Speech echoes names with the project number; report the project id.
    project,
    location: parsed.location,
    items: stripOwnershipItems(customClass.items),
    uid: customClass.uid,
    state: customClass.state,
    kmsKeyName: customClass.kmsKeyName,
  };
};

export const CustomClassProvider = () =>
  Provider.succeed(CustomClass, {
    stables: ["name", "customClassId", "project", "location", "uid"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.customClassId ?? output?.customClassId,
        nextId: news.customClassId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
      });
    }),

    lookup: Effect.fn(function* ({ customClassId, location: lookupLocation }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(lookupLocation);
      const existing = yield* getCustomClass(
        customClassNameOf(env.project, location, customClassId),
      );
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }, inLookupProject),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const customClassId = yield* toPhysicalId(id, olds?.customClassId, output?.customClassId);
      const existing = yield* getCustomClass(
        output?.name ?? customClassNameOf(env.project, location, customClassId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels: a generated id derives from this stack, stage, logical
      // id and instance; an explicit id is only ours when state has it.
      return output !== undefined || olds?.customClassId === undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const classes = yield* listOwnedCustomClasses(env.project);
        return classes.map((customClass) => toAttrs(customClass, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location ?? DEFAULT_LOCATION);
      const customClassId = yield* toPhysicalId(id, news.customClassId, output?.customClassId);
      const items = news.items ?? [];
      const name = output?.name ?? customClassNameOf(env.project, location, customClassId);

      let current = yield* getCustomClass(name);

      if (current === undefined) {
        const created = yield* speech
          .createProjectsLocationsCustomClasses({
            parent: locationParent(env.project, location),
            body: {
              customClassId,
              customClass: { items },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getCustomClass(customClassNameOf(env.project, location, customClassId)),
            ),
          );
        current = created ?? undefined;
        if (current?.name) {
          current = (yield* getCustomClass(current.name)) ?? current;
        }
      }

      if (current === undefined) {
        return yield* new CustomClassNotResolved({
          resourceName: name || customClassNameOf(env.project, location, customClassId),
        });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        markerFromItems(current.items) === undefined && sameItems(current.items, news.items)
          ? undefined
          : "items",
      );
      if (updateMask.length > 0) {
        current = yield* speech.patchProjectsLocationsCustomClasses({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            items,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteCustomClass(output.name);
      yield* waitUntilGone(getCustomClass(output.name));
    }),
  });
