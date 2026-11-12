import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  ColumnMask as ColumnMaskShape,
  CreateColumnMaskRequestColumnMaskType,
} from "@distilled.cloud/starburst-galaxy/column_mask";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  changedFields,
  collectAll,
  findFirst,
  hasChanges,
  ownership,
  physicalName,
  GOVERNANCE_NAME,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface ColumnMaskProps {
  /**
   * Mask name, as Galaxy's policies show it. Renaming updates the mask in place.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /**
   * SQL expression whose value replaces the column's, e.g.
   * `'XXX-XX-' || substr(ssn, -4)`. It must return `type`.
   */
  readonly expression: string;
  /** SQL type of the masked column, e.g. `"Varchar"`, `"Integer"`, or `"Any"`. */
  readonly type: CreateColumnMaskRequestColumnMaskType;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
}

export interface ColumnMaskAttributes {
  /** Galaxy's column mask ID. Policies attach masks by this ID. */
  readonly columnMaskId: string;
  /** Mask name. */
  readonly name: string;
  /** Masking SQL expression. */
  readonly expression: string;
  /** SQL type of the masked column. */
  readonly type: string;
  /** Description shown in Galaxy. */
  readonly description: string;
  /** Creation time. */
  readonly created: string;
  /** Last modification time. */
  readonly modified: string;
}

export type ColumnMask = Resource<
  "StarburstGalaxy.ColumnMask",
  ColumnMaskProps,
  ColumnMaskAttributes,
  never,
  Providers
>;

/**
 * A Starburst Galaxy column mask: a SQL expression that replaces a
 * column's value for the roles a policy applies to. A policy attaches the
 * mask to columns by `columnMaskId`.
 *
 * Every prop updates in place, the name included. Masks have no labels or
 * tags in Galaxy: a mask Alchemy created is recognized by its generated
 * name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security/policies.html
 *
 * ### Creating a column mask
 * **Example:** Show only the last four digits of a social security number
 * ```typescript
 * const ssnMask = yield* StarburstGalaxy.ColumnMask("SsnMask", {
 *   type: "Varchar",
 *   expression: "'XXX-XX-' || substr(ssn, -4)",
 *   description: "Mask SSNs for everyone but HR",
 * });
 * ```
 *
 * **Example:** Null out a numeric column
 * ```typescript
 * yield* StarburstGalaxy.ColumnMask("SalaryMask", {
 *   type: "Integer",
 *   expression: "CAST(NULL AS integer)",
 * });
 * ```
 *
 * @resource
 * @product Data governance
 */
export const ColumnMask = Resource<ColumnMask>("StarburstGalaxy.ColumnMask");

/** Galaxy accepted a column mask create but the mask could not be read back. */
export class ColumnMaskNotResolved extends Data.TaggedError(
  "StarburstGalaxy.ColumnMaskNotResolved",
)<{
  readonly maskName: string;
}> {
  override get message() {
    return `Column mask ${this.maskName} could not be found after it was created`;
  }
}

const toAttributes = (mask: ColumnMaskShape): ColumnMaskAttributes => ({
  columnMaskId: mask.columnMaskId,
  name: mask.name,
  expression: mask.expression,
  type: mask.columnMaskType,
  description: mask.description,
  created: mask.created,
  modified: mask.modified,
});

const getMask = (columnMaskId: string) =>
  galaxy.columnMask
    .getColumnMask({ columnMaskId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.columnMask.listColumnMasks.items({}), (mask) => mask.name === name);

const observe = Effect.fn(function* (columnMaskId: string | undefined, name: string) {
  if (columnMaskId !== undefined) {
    const byId = yield* getMask(columnMaskId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const ColumnMaskProvider = () =>
  Provider.succeed(ColumnMask, {
    stables: ["columnMaskId", "created"],

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, GOVERNANCE_NAME));
      const mask = yield* observe(output?.columnMaskId, name);
      if (mask === undefined) return undefined;
      return ownership(toAttributes(mask), {
        output,
        explicitName: olds?.name,
        previous,
        key: "columnMaskId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, GOVERNANCE_NAME);
      const desired = {
        name,
        expression: news.expression,
        columnMaskType: news.type,
        description: news.description ?? "",
      };

      // Observe
      let mask = yield* observe(output?.columnMaskId, name);

      // Ensure
      if (mask === undefined) {
        yield* session.note(`Creating column mask ${name}...`);
        const created = yield* galaxy.columnMask
          .createColumnMask(desired)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        mask = created ?? (yield* findByName(name));
      }
      if (mask === undefined) {
        return yield* new ColumnMaskNotResolved({ maskName: name });
      }

      // Sync
      const delta = changedFields(mask, desired);
      if (hasChanges(delta)) {
        yield* session.note(`Updating column mask ${name}...`);
        mask = yield* galaxy.columnMask.updateColumnMask({
          ...delta,
          columnMaskId: mask.columnMaskId,
        });
      }

      return toAttributes(mask);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.columnMask
        .deleteColumnMask({ columnMaskId: output.columnMaskId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => collectAll(galaxy.columnMask.listColumnMasks.items({}), toAttributes),
  });
