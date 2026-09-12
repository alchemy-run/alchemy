import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  ignoreList,
  listAccessibleAdvertiserIds,
  listAccessiblePartnerIds,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

export type InventorySourceGroupProps = {
  /**
   * Partner that owns the group. Mutually exclusive with `advertiserId`.
   * Immutable — changing it replaces the group.
   */
  partnerId?: string;
  /**
   * Advertiser that owns the group. Mutually exclusive with `partnerId`.
   * Immutable — changing it replaces the group.
   */
  advertiserId?: string;
  /**
   * System-assigned inventory source group id. Omit on create; pass the
   * observed id to update in place.
   */
  inventorySourceGroupId?: string;
  /**
   * Display name (max 240 bytes). Inventory source groups have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
};

export type InventorySourceGroup = Resource<
  "GCP.Displayvideo.InventorySourceGroup",
  InventorySourceGroupProps,
  {
    /** Resource name `inventorySourceGroups/{group}`. */
    name: string;
    /** System-assigned inventory source group id. */
    inventorySourceGroupId: string;
    /** Partner owner id, if partner-owned. */
    partnerId: string | undefined;
    /** Advertiser owner id, if advertiser-owned. */
    advertiserId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 inventory source group.
 *
 * Groups have no labels field — Alchemy stamps ownership into the display
 * name so `list` / nuke can find them. Owner (`partnerId` or
 * `advertiserId`) is immutable. Display name updates in place.
 *
 * ### Creating an Inventory Source Group
 * **Example:** Partner-owned group
 * ```typescript
 * const group = yield* GCP.Displayvideo.InventorySourceGroup("Premium", {
 *   partnerId: "123",
 *   displayName: "premium-publishers",
 * });
 * ```
 *
 * **Example:** Advertiser-owned group
 * ```typescript
 * const group = yield* GCP.Displayvideo.InventorySourceGroup("Premium", {
 *   advertiserId: advertiser.advertiserId,
 *   displayName: "premium-publishers",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const InventorySourceGroup = Resource<InventorySourceGroup>(
  "GCP.Displayvideo.InventorySourceGroup",
);

export class InventorySourceGroupNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.InventorySourceGroupNotResolved",
)<{
  inventorySourceGroupId: string;
}> {}

const ownerOf = (props: { partnerId?: string; advertiserId?: string }) => ({
  partnerId: props.partnerId,
  advertiserId: props.advertiserId,
});

const toAttrs = (
  group: dv.InventorySourceGroup,
  owner: { partnerId?: string; advertiserId?: string },
) => {
  const parsed = parseOwnership(group.displayName);
  return {
    name: group.name ?? "",
    inventorySourceGroupId: group.inventorySourceGroupId ?? "",
    partnerId: owner.partnerId,
    advertiserId: owner.advertiserId,
    displayName: parsed.text,
  };
};

const getById = (
  inventorySourceGroupId: string | undefined,
  owner: { partnerId?: string; advertiserId?: string },
) =>
  !inventorySourceGroupId
    ? Effect.succeed(undefined)
    : dv
        .getInventorySourceGroups({
          inventorySourceGroupId,
          partnerId: owner.partnerId,
          advertiserId: owner.advertiserId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (owner: { partnerId?: string; advertiserId?: string }) =>
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
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.InventorySourceGroup[]),
    );

const findByDisplayName = (
  owner: { partnerId?: string; advertiserId?: string },
  displayName: string,
) =>
  listAt(owner).pipe(
    Effect.map((groups) =>
      groups.find((group) => group.displayName === displayName),
    ),
  );

export const InventorySourceGroupProvider = () =>
  Provider.succeed(InventorySourceGroup, {
    stables: ["name", "inventorySourceGroupId", "partnerId", "advertiserId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPartner = olds?.partnerId ?? output?.partnerId;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        (previousPartner !== undefined &&
          (news.partnerId ?? "") !== (previousPartner ?? "")) ||
        (previousAdvertiser !== undefined &&
          (news.advertiserId ?? "") !== (previousAdvertiser ?? ""))
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.inventorySourceGroupId ?? output?.inventorySourceGroupId;
      if (
        previousId !== undefined &&
        news.inventorySourceGroupId !== undefined &&
        news.inventorySourceGroupId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const owner = ownerOf({
        partnerId: olds?.partnerId ?? output?.partnerId,
        advertiserId: olds?.advertiserId ?? output?.advertiserId,
      });
      let existing = yield* getById(
        olds?.inventorySourceGroupId ?? output?.inventorySourceGroupId,
        owner,
      );
      if (existing === undefined && (owner.partnerId || owner.advertiserId)) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          owner,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, owner);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const seen = new Set<string>();
        const owners: Array<{ partnerId?: string; advertiserId?: string }> = [];
        const partnerIds = yield* listAccessiblePartnerIds();
        for (const partnerId of partnerIds) owners.push({ partnerId });
        const advertiserIds = yield* listAccessibleAdvertiserIds();
        for (const advertiserId of advertiserIds) owners.push({ advertiserId });
        const pages = yield* Effect.forEach(owners, (owner) => listAt(owner), {
          concurrency: 4,
        });
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const owner = owners[i]!;
          for (const group of pages[i] ?? []) {
            const id = group.inventorySourceGroupId ?? "";
            if (!id || seen.has(id) || !hasOwnershipMarker(group.displayName)) {
              continue;
            }
            seen.add(id);
            attrs.push(toAttrs(group, owner));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const owner = ownerOf(news);
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);

      let current = yield* getById(
        news.inventorySourceGroupId ?? output?.inventorySourceGroupId,
        owner,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(owner, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createInventorySourceGroups({
            partnerId: owner.partnerId,
            advertiserId: owner.advertiserId,
            body: { displayName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(owner, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new InventorySourceGroupNotResolved({
          inventorySourceGroupId:
            news.inventorySourceGroupId ??
            output?.inventorySourceGroupId ??
            displayName,
        });
      }

      const inventorySourceGroupId = current.inventorySourceGroupId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* dv.patchInventorySourceGroups({
          inventorySourceGroupId,
          partnerId: owner.partnerId,
          advertiserId: owner.advertiserId,
          updateMask: updateMaskOf("displayName"),
          body: {
            inventorySourceGroupId,
            displayName,
          },
        });
      }

      return toAttrs(current, owner);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.inventorySourceGroupId) return;
      yield* dv
        .deleteInventorySourceGroups({
          inventorySourceGroupId: output.inventorySourceGroupId,
          partnerId: output.partnerId,
          advertiserId: output.advertiserId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
