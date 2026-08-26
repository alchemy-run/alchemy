import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type ClassItem,
  DEFAULT_LOCATION,
  deleteCustomClass,
  findOwnedCustomClass,
  getCustomClass,
  listOwnedCustomClasses,
  locationParent,
  markerFromItems,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  sameItems,
  stripOwnershipItems,
  toPhysicalId,
  updateMaskOf,
  waitUntilGone,
  withOwnershipItems,
} from "./internal.ts";

export type { ClassItem };

export type CustomClasseProps = {
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
   * Class items (words or phrases that represent one concept). Alchemy
   * stamps a reserved ownership item and strips it from attributes.
   */
  items?: ClassItem[];
};

export type CustomClasse = Resource<
  "GCP.Speech.CustomClasse",
  CustomClasseProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/customClasses/{custom_class}`. */
    name: string;
    /** Custom class id (last path segment). */
    customClassId: string;
    /** Project id. */
    project: string;
    /** Adaptation location. */
    location: string;
    /** User class items (Alchemy ownership item stripped). */
    items: ClassItem[];
    /** Server-assigned uid, if present. */
    uid: string | undefined;
    /** Lifecycle state, if present. */
    state: string | undefined;
    /** KMS key encrypting class items, if any. */
    kmsKeyName: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Speech-to-Text Adaptation custom class. Custom classes group words
 * that represent one concept (for example passenger ship names) and are
 * referenced from PhraseSet hints as `${custom_class_id}`.
 *
 * Speech-to-Text v1 classes have no labels field, so Alchemy stamps
 * ownership into a reserved class item for `list` / nuke. Location and
 * custom class id are identity — changing either replaces the class.
 * `items` update in place.
 *
 * ### Creating a Custom Class
 * **Example:** Generated id
 * ```typescript
 * const ships = yield* GCP.Speech.CustomClasse("Ships", {
 *   items: [{ value: "sloop" }, { value: "ketch" }],
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const ships = yield* GCP.Speech.CustomClasse("Ships", {
 *   location: "global",
 *   customClassId: "passenger-ships",
 *   items: [{ value: "sloop" }],
 * });
 * ```
 *
 * ### Updating a Custom Class
 * **Example:** Replace the class items
 * ```typescript
 * const ships = yield* GCP.Speech.CustomClasse("Ships", {
 *   customClassId: existing.customClassId,
 *   items: [{ value: "brig" }, { value: "barque" }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Speech
 */
export const CustomClasse = Resource<CustomClasse>("GCP.Speech.CustomClasse");

/** Alias matching the Speech-to-Text API type name. */
export const CustomClass = CustomClasse;
export type CustomClass = CustomClasse;

export class CustomClasseNotResolved extends Data.TaggedError(
  "GCP.Speech.CustomClasseNotResolved",
)<{
  name: string;
}> {}

const customClassNameOf = (
  project: string,
  location: string,
  customClassId: string,
) => resourceNameOf(project, location, "customClasses", customClassId);

const toAttrs = (customClass: speech.CustomClass, project: string) => {
  const name = customClass.name ?? "";
  const parsed = parseResourceName(name, "customClasses");
  return {
    name,
    customClassId: parsed.id || customClass.customClassId || "",
    project: parsed.project || project,
    location: parsed.location,
    items: stripOwnershipItems(customClass.items),
    uid: customClass.uid,
    state: customClass.state,
    kmsKeyName: customClass.kmsKeyName,
  };
};

export const CustomClasseProvider = () =>
  Provider.succeed(CustomClasse, {
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

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        customClassNameOf(
          env.project,
          location,
          olds?.customClassId ?? output?.customClassId ?? "",
        );
      let existing = yield* getCustomClass(name);
      if (existing === undefined) {
        existing = yield* findOwnedCustomClass(id, env.project, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, markerFromItems(existing.items)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const classes = yield* listOwnedCustomClasses(env.project);
        return classes.map((customClass) => toAttrs(customClass, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const ownership = yield* ownershipLabels(id);
      const customClassId = yield* toPhysicalId(
        id,
        news.customClassId,
        output?.customClassId,
      );
      const items = withOwnershipItems(news.items, ownership);
      const name =
        output?.name ?? customClassNameOf(env.project, location, customClassId);

      let current = yield* getCustomClass(name);
      if (current === undefined) {
        current = yield* findOwnedCustomClass(id, env.project, name);
      }

      if (current === undefined) {
        const created = yield* speech
          .createProjectsLocationsCustomClasses({
            parent: locationParent(env.project, location),
            body: {
              customClassId,
              customClass: {
                customClassId,
                items,
              },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getCustomClass(
                customClassNameOf(env.project, location, customClassId),
              ),
            ),
          );
        current = created ?? undefined;
        if (current?.name) {
          current = (yield* getCustomClass(current.name)) ?? current;
        }
      }

      if (current === undefined) {
        return yield* new CustomClasseNotResolved({
          name: name || customClassNameOf(env.project, location, customClassId),
        });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        sameItems(stripOwnershipItems(current.items), news.items)
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
