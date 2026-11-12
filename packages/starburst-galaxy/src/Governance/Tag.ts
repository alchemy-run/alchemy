import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Tag as TagShape } from "@distilled.cloud/starburst-galaxy/tag";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  changedFields,
  collectAll,
  findFirst,
  GOVERNANCE_NAME,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface TagProps {
  /**
   * Tag name, as Galaxy's catalog explorer shows it. Renaming updates the tag in place.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /** Display color, as a hex code such as `"#FF0000"`. */
  readonly color: string;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
}

export interface TagAttributes {
  /** Galaxy's tag ID. */
  readonly tagId: string;
  /** Tag name. */
  readonly name: string;
  /** Display color. */
  readonly color: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
}

/** Find a tag this stack doesn't manage by its name. */
export interface TagLookup {
  /** Tag name. */
  readonly name: string;
}

export type Tag = Resource<
  "StarburstGalaxy.Tag",
  TagProps,
  TagAttributes,
  never,
  Providers,
  TagLookup
>;

/**
 * A Starburst Galaxy tag: a named, colored label for catalogs, schemas,
 * tables and columns (data classification such as PII). Apply it with
 * `StarburstGalaxy.TagAssignment`.
 *
 * Every prop updates in place, the name included. Tags have no labels of
 * their own: a tag Alchemy created is recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/data-engineering/working-with-data-lakes/tags.html
 *
 * ### Creating a tag
 * **Example:** A tag for personal data
 * ```typescript
 * const pii = yield* StarburstGalaxy.Tag("Pii", {
 *   color: "#FF0000",
 *   description: "Personally identifiable information",
 * });
 * ```
 *
 * ### Tagging a catalog
 * **Example:** Mark a whole catalog as PII
 * ```typescript
 * const catalog = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "customers" });
 * const pii = yield* StarburstGalaxy.Tag("Pii", { color: "#FF0000" });
 * yield* StarburstGalaxy.TagAssignment("CustomersPii", {
 *   tag: pii.tagId,
 *   catalog: catalog.catalogId,
 * });
 * ```
 *
 * ### Looking up an existing tag
 * **Example:** Reference a tag created in the Galaxy console
 * ```typescript
 * const finance = StarburstGalaxy.Tag.lookup({ name: "finance" });
 * ```
 *
 * @resource
 * @product Data governance
 */
export const Tag = Resource<Tag>("StarburstGalaxy.Tag");

/** Galaxy accepted a tag create but the tag could not be read back. */
export class TagNotResolved extends Data.TaggedError("StarburstGalaxy.TagNotResolved")<{
  readonly tagName: string;
}> {
  override get message() {
    return `Tag ${this.tagName} could not be found after it was created`;
  }
}

const toAttributes = (tag: TagShape): TagAttributes => ({
  tagId: tag.tagId,
  name: tag.name,
  color: tag.color,
  description: tag.description,
});

const getTag = (tagId: string) =>
  galaxy.tag.getTag({ tagId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.tag.listTags.items({}), (tag) => tag.name === name);

const observe = Effect.fn(function* (tagId: string | undefined, name: string) {
  if (tagId !== undefined) {
    const byId = yield* getTag(tagId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const TagProvider = () =>
  Provider.succeed(Tag, {
    stables: ["tagId"],

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, GOVERNANCE_NAME));
      const tag = yield* observe(output?.tagId, name);
      if (tag === undefined) return undefined;
      return ownership(toAttributes(tag), {
        output,
        explicitName: olds?.name,
        previous,
        key: "tagId",
      });
    }),

    lookup: Effect.fn(function* ({ name }) {
      const tag = yield* findByName(name);
      return tag === undefined ? undefined : toAttributes(tag);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, GOVERNANCE_NAME);
      const desired = { name, color: news.color, description: news.description ?? "" };

      // Observe
      let tag = yield* observe(output?.tagId, name);

      // Ensure
      if (tag === undefined) {
        yield* session.note(`Creating tag ${name}...`);
        const created = yield* galaxy.tag
          .createTag(desired)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        tag = created ?? (yield* findByName(name));
      }
      if (tag === undefined) {
        return yield* new TagNotResolved({ tagName: name });
      }

      // Sync
      const delta = changedFields({ ...tag, description: tag.description ?? "" }, desired);
      if (hasChanges(delta)) {
        yield* session.note(`Updating tag ${name}...`);
        tag = yield* galaxy.tag.updateTag({ ...delta, tagId: tag.tagId });
      }

      return toAttributes(tag);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.tag
        .deleteTag({ tagId: output.tagId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.tag.listTags.items({}).pipe(Stream.filter((item) => isGeneratedName(item.name))),
        toAttributes,
      ),
  });
