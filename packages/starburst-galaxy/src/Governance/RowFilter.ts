import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { RowFilter as RowFilterShape } from "@distilled.cloud/starburst-galaxy/row_filter";
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

export interface RowFilterProps {
  /**
   * Filter name, as Galaxy's policies show it. Renaming updates the filter in place.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /**
   * SQL boolean expression a row must satisfy to be visible, e.g.
   * `region = 'EU'`.
   */
  readonly expression: string;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
}

export interface RowFilterAttributes {
  /** Galaxy's row filter ID. Policies attach filters by this ID. */
  readonly rowFilterId: string;
  /** Filter name. */
  readonly name: string;
  /** Filtering SQL expression. */
  readonly expression: string;
  /** Description shown in Galaxy. */
  readonly description: string;
  /** Creation time. */
  readonly created: string;
  /** Last modification time. */
  readonly modified: string;
}

export type RowFilter = Resource<
  "StarburstGalaxy.Governance.RowFilter",
  RowFilterProps,
  RowFilterAttributes,
  never,
  Providers
>;

/**
 * A Starburst Galaxy row filter: a SQL predicate that hides rows from the
 * roles a policy applies to. A policy attaches the filter to tables by
 * `rowFilterId`.
 *
 * Every prop updates in place, the name included. Filters have no labels
 * or tags in Galaxy: a filter Alchemy created is recognized by its
 * generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security/policies.html
 *
 * ### Creating a row filter
 * **Example:** Show only European rows
 * ```typescript
 * const euOnly = yield* StarburstGalaxy.Governance.RowFilter("EuOnly", {
 *   expression: "region = 'EU'",
 *   description: "Rows visible to the EU team",
 * });
 * ```
 *
 * **Example:** Show each user only their own rows
 * ```typescript
 * yield* StarburstGalaxy.Governance.RowFilter("OwnRows", {
 *   expression: "owner_email = current_user",
 * });
 * ```
 *
 * @resource
 * @product Data governance
 */
export const RowFilter = Resource<RowFilter>("StarburstGalaxy.Governance.RowFilter");

/** Galaxy accepted a row filter create but the filter could not be read back. */
export class RowFilterNotResolved extends Data.TaggedError("StarburstGalaxy.RowFilterNotResolved")<{
  readonly filterName: string;
}> {
  override get message() {
    return `Row filter ${this.filterName} could not be found after it was created`;
  }
}

const toAttributes = (filter: RowFilterShape): RowFilterAttributes => ({
  rowFilterId: filter.rowFilterId,
  name: filter.name,
  expression: filter.expression,
  description: filter.description,
  created: filter.created,
  modified: filter.modified,
});

const getFilter = (rowFilterId: string) =>
  galaxy.rowFilter
    .getRowFilter({ rowFilterId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.rowFilter.listRowFilters.items({}), (filter) => filter.name === name);

const observe = Effect.fn(function* (rowFilterId: string | undefined, name: string) {
  if (rowFilterId !== undefined) {
    const byId = yield* getFilter(rowFilterId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const RowFilterProvider = () =>
  Provider.succeed(RowFilter, {
    stables: ["rowFilterId", "created"],

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, GOVERNANCE_NAME));
      const filter = yield* observe(output?.rowFilterId, name);
      if (filter === undefined) return undefined;
      return ownership(toAttributes(filter), {
        output,
        explicitName: olds?.name,
        previous,
        key: "rowFilterId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, GOVERNANCE_NAME);
      const desired = {
        name,
        expression: news.expression,
        description: news.description ?? "",
      };

      // Observe
      let filter = yield* observe(output?.rowFilterId, name);

      // Ensure
      if (filter === undefined) {
        yield* session.note(`Creating row filter ${name}...`);
        const created = yield* galaxy.rowFilter
          .createRowFilter(desired)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        filter = created ?? (yield* findByName(name));
      }
      if (filter === undefined) {
        return yield* new RowFilterNotResolved({ filterName: name });
      }

      // Sync
      const delta = changedFields(filter, desired);
      if (hasChanges(delta)) {
        yield* session.note(`Updating row filter ${name}...`);
        filter = yield* galaxy.rowFilter.updateRowFilter({
          ...delta,
          rowFilterId: filter.rowFilterId,
        });
      }

      return toAttributes(filter);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.rowFilter
        .deleteRowFilter({ rowFilterId: output.rowFilterId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.rowFilter.listRowFilters
          .items({})
          .pipe(Stream.filter((item) => isGeneratedName(item.name))),
        toAttributes,
      ),
  });
