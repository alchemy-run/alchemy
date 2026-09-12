import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  hasOwnershipMarker,
  ignoreList,
  listAccessibleAdvertiserIds,
  listAccessiblePartnerIds,
  parsePathId,
} from "./ownership.ts";

export type InventorySourceGroupsAssignedInventorySourceProps = {
  /**
   * Parent inventory source group id. Immutable — changing it replaces
   * the assignment.
   */
  inventorySourceGroupId: string;
  /**
   * Inventory source being assigned. Immutable — changing it replaces
   * the assignment.
   */
  inventorySourceId: string;
  /**
   * Partner that owns the parent group. Mutually exclusive with
   * `advertiserId`.
   */
  partnerId?: string;
  /**
   * Advertiser that owns the parent group. Mutually exclusive with
   * `partnerId`.
   */
  advertiserId?: string;
  /**
   * System-assigned assignment id. Omit on create; pass the observed id
   * to target an existing assignment.
   */
  assignedInventorySourceId?: string;
};

export type InventorySourceGroupsAssignedInventorySource = Resource<
  "GCP.Displayvideo.InventorySourceGroupsAssignedInventorySource",
  InventorySourceGroupsAssignedInventorySourceProps,
  {
    /** Resource name `inventorySourceGroups/{group}/assignedInventorySources/{id}`. */
    name: string;
    /** Parent inventory source group id. */
    inventorySourceGroupId: string;
    /** Assigned inventory source id. */
    inventorySourceId: string;
    /** System-assigned assignment id. */
    assignedInventorySourceId: string;
    /** Partner owner of the parent group, if partner-owned. */
    partnerId: string | undefined;
    /** Advertiser owner of the parent group, if advertiser-owned. */
    advertiserId: string | undefined;
  },
  never,
  Providers
>;

/**
 * An assignment of an inventory source to a Display and Video 360
 * inventory source group.
 *
 * Assignments have no labels or display name — Alchemy lists them under
 * alchemy-owned parent groups so `list` / nuke can find them. Group,
 * inventory source, and owner are identity; changing them replaces the
 * assignment.
 *
 * ### Creating an Assignment
 * **Example:** Add a source to a group
 * ```typescript
 * const assigned = yield* GCP.Displayvideo.InventorySourceGroupsAssignedInventorySource("Deal", {
 *   inventorySourceGroupId: group.inventorySourceGroupId,
 *   inventorySourceId: source.inventorySourceId,
 *   advertiserId: advertiser.advertiserId,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const InventorySourceGroupsAssignedInventorySource =
  Resource<InventorySourceGroupsAssignedInventorySource>(
    "GCP.Displayvideo.InventorySourceGroupsAssignedInventorySource",
  );

export class InventorySourceGroupsAssignedInventorySourceNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.InventorySourceGroupsAssignedInventorySourceNotResolved",
)<{
  assignedInventorySourceId: string;
}> {}

type Owner = { partnerId?: string; advertiserId?: string };

const ownerOf = (props: Owner): Owner => ({
  partnerId: props.partnerId,
  advertiserId: props.advertiserId,
});

const toAttrs = (
  assigned: dv.AssignedInventorySource,
  inventorySourceGroupId: string,
  owner: Owner,
) => ({
  name: assigned.name ?? "",
  inventorySourceGroupId:
    parsePathId(assigned.name ?? "", "inventorySourceGroups") ||
    inventorySourceGroupId,
  inventorySourceId: assigned.inventorySourceId ?? "",
  assignedInventorySourceId: assigned.assignedInventorySourceId ?? "",
  partnerId: owner.partnerId,
  advertiserId: owner.advertiserId,
});

const listAt = (inventorySourceGroupId: string, owner: Owner) =>
  dv.listInventorySourceGroupsAssignedInventorySources
    .pages({
      inventorySourceGroupId,
      partnerId: owner.partnerId,
      advertiserId: owner.advertiserId,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.assignedInventorySources ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.AssignedInventorySource[]),
    );

const findAssigned = (
  inventorySourceGroupId: string,
  owner: Owner,
  match: {
    assignedInventorySourceId?: string;
    inventorySourceId?: string;
  },
) =>
  listAt(inventorySourceGroupId, owner).pipe(
    Effect.map((assigned) =>
      assigned.find(
        (row) =>
          (match.assignedInventorySourceId !== undefined &&
            row.assignedInventorySourceId ===
              match.assignedInventorySourceId) ||
          (match.inventorySourceId !== undefined &&
            row.inventorySourceId === match.inventorySourceId),
      ),
    ),
  );

const listOwnedGroups = (owner: Owner) =>
  dv.listInventorySourceGroups
    .pages({
      partnerId: owner.partnerId,
      advertiserId: owner.advertiserId,
      pageSize: 200,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.inventorySourceGroups ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).filter((group) =>
          hasOwnershipMarker(group.displayName),
        ),
      ),
      ignoreList([] as dv.InventorySourceGroup[]),
    );

export const InventorySourceGroupsAssignedInventorySourceProvider = () =>
  Provider.succeed(InventorySourceGroupsAssignedInventorySource, {
    stables: [
      "name",
      "inventorySourceGroupId",
      "assignedInventorySourceId",
      "inventorySourceId",
      "partnerId",
      "advertiserId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousGroup =
        olds?.inventorySourceGroupId ?? output?.inventorySourceGroupId;
      if (
        previousGroup !== undefined &&
        news.inventorySourceGroupId !== previousGroup
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousSource =
        olds?.inventorySourceId ?? output?.inventorySourceId;
      if (
        previousSource !== undefined &&
        news.inventorySourceId !== previousSource
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousPartner = olds?.partnerId ?? output?.partnerId;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        (previousPartner !== undefined &&
          (news.partnerId ?? "") !== (previousPartner ?? "")) ||
        (previousAdvertiser !== undefined &&
          (news.advertiserId ?? "") !== (previousAdvertiser ?? ""))
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId =
        olds?.assignedInventorySourceId ?? output?.assignedInventorySourceId;
      if (
        previousId !== undefined &&
        news.assignedInventorySourceId !== undefined &&
        news.assignedInventorySourceId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const owner = ownerOf({
        partnerId: olds?.partnerId ?? output?.partnerId,
        advertiserId: olds?.advertiserId ?? output?.advertiserId,
      });
      const inventorySourceGroupId =
        olds?.inventorySourceGroupId ?? output?.inventorySourceGroupId ?? "";
      if (!inventorySourceGroupId) return undefined;
      const existing = yield* findAssigned(inventorySourceGroupId, owner, {
        assignedInventorySourceId:
          olds?.assignedInventorySourceId ?? output?.assignedInventorySourceId,
        inventorySourceId: olds?.inventorySourceId ?? output?.inventorySourceId,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, inventorySourceGroupId, owner);
      return attrs;
    }),

    list: () =>
      Effect.gen(function* () {
        const seen = new Set<string>();
        const owners: Owner[] = [];
        const partnerIds = yield* listAccessiblePartnerIds();
        for (const partnerId of partnerIds) owners.push({ partnerId });
        const advertiserIds = yield* listAccessibleAdvertiserIds();
        for (const advertiserId of advertiserIds) owners.push({ advertiserId });
        const attrs = [];
        const groupsByOwner = yield* Effect.forEach(
          owners,
          (owner) => listOwnedGroups(owner),
          { concurrency: 4 },
        );
        for (let i = 0; i < groupsByOwner.length; i++) {
          const owner = owners[i]!;
          const groups = groupsByOwner[i] ?? [];
          const pages = yield* Effect.forEach(
            groups,
            (group) =>
              group.inventorySourceGroupId
                ? listAt(group.inventorySourceGroupId, owner).pipe(
                    Effect.map((rows) =>
                      rows.map((row) =>
                        toAttrs(row, group.inventorySourceGroupId ?? "", owner),
                      ),
                    ),
                  )
                : Effect.succeed([] as ReturnType<typeof toAttrs>[]),
            { concurrency: 4 },
          );
          for (const page of pages) {
            for (const assigned of page) {
              const key = `${assigned.inventorySourceGroupId}/${assigned.assignedInventorySourceId}`;
              if (!assigned.assignedInventorySourceId || seen.has(key)) {
                continue;
              }
              seen.add(key);
              attrs.push(assigned);
            }
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const owner = ownerOf(news);
      const inventorySourceGroupId = news.inventorySourceGroupId;
      const inventorySourceId = news.inventorySourceId;

      let current = yield* findAssigned(inventorySourceGroupId, owner, {
        assignedInventorySourceId:
          news.assignedInventorySourceId ?? output?.assignedInventorySourceId,
        inventorySourceId,
      });

      if (current === undefined) {
        const created = yield* dv
          .createInventorySourceGroupsAssignedInventorySources({
            inventorySourceGroupId,
            partnerId: owner.partnerId,
            advertiserId: owner.advertiserId,
            body: { inventorySourceId },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findAssigned(inventorySourceGroupId, owner, {
                inventorySourceId,
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new InventorySourceGroupsAssignedInventorySourceNotResolved(
          {
            assignedInventorySourceId:
              news.assignedInventorySourceId ??
              output?.assignedInventorySourceId ??
              inventorySourceId,
          },
        );
      }

      return toAttrs(current, inventorySourceGroupId, owner);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.inventorySourceGroupId || !output.assignedInventorySourceId) {
        return;
      }
      yield* dv
        .deleteInventorySourceGroupsAssignedInventorySources({
          inventorySourceGroupId: output.inventorySourceGroupId,
          assignedInventorySourceId: output.assignedInventorySourceId,
          partnerId: output.partnerId,
          advertiserId: output.advertiserId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
