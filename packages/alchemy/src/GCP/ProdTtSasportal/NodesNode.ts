import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  expandNode,
  findOwned,
  getNodeNode,
  hasOwnershipMarker,
  ignoreMissing,
  listAllNodeNodes,
  listNodeNodes,
  nodeAttrs,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameStringList,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type NodesNodeProps = {
  /**
   * Parent SAS node (`nodes/{node}` or a nested customer node name).
   * Immutable — changing it replaces the node.
   */
  node: string;
  /**
   * Full resource name. Server-assigned on create. Immutable — changing
   * it replaces the node.
   */
  name?: string;
  /**
   * Human-readable name. Nodes have no labels field, so Alchemy stamps
   * ownership into this field.
   */
  displayName?: string;
  /**
   * User IDs used by devices belonging to this node.
   */
  sasUserIds?: string[];
};

export type NodesNode = Resource<
  "GCP.ProdTtSasportal.NodesNode",
  NodesNodeProps,
  {
    /** Full resource name `nodes/{node}/nodes/{node}`. */
    name: string;
    /** Parent node resource name. */
    parent: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** User IDs used by devices under this node. */
    sasUserIds: string[];
  },
  never,
  Providers
>;

/**
 * A nested Spectrum Access System (SAS) Portal node under another node
 * in the production-test (prod-tt) environment.
 *
 * Nodes have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent node and resource name are
 * identity. Display name and SAS user ids update in place.
 *
 * ### Creating a Nested Node
 * **Example:** Child node under a parent node
 * ```typescript
 * const child = yield* GCP.ProdTtSasportal.NodesNode("Building", {
 *   node: parent.name,
 *   displayName: "bldg-a",
 * });
 * ```
 *
 * ### Updating a Nested Node
 * **Example:** Change the display name
 * ```typescript
 * const child = yield* GCP.ProdTtSasportal.NodesNode("Building", {
 *   node: existing.parent,
 *   name: existing.name,
 *   displayName: "bldg-b",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const NodesNode = Resource<NodesNode>("GCP.ProdTtSasportal.NodesNode");

export class NodesNodeNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.NodesNodeNotResolved",
)<{
  name: string;
}> {}

export const NodesNodeProvider = () =>
  Provider.succeed(NodesNode, {
    stables: ["name", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.node ?? output?.parent;
      return replaceOnIdentity({
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
        previousParent: previousParent ? expandNode(previousParent) : undefined,
        nextParent: expandNode(news.node),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const parent = expandNode(olds?.node ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getNodeNode(name);
      if (existing === undefined) {
        existing = yield* findOwned(yield* listNodeNodes(parent), id);
      }
      if (existing === undefined) return undefined;
      const attrs = nodeAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllNodeNodes();
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => nodeAttrs(item, ""));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = expandNode(news.node);
      const name = news.name ?? output?.name ?? "";
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName),
      );

      let current = yield* getNodeNode(name);
      if (current === undefined) {
        current = yield* findOwned(yield* listNodeNodes(parent), id);
      }

      if (current === undefined) {
        const created = yield* sas
          .createNodesNodes({
            parent,
            body: {
              displayName,
              sasUserIds: news.sasUserIds,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listNodeNodes(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NodesNodeNotResolved({ name: name || parent });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const usersChanged =
        news.sasUserIds !== undefined &&
        !sameStringList(current.sasUserIds, news.sasUserIds);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        usersChanged ? "sasUserIds" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* sas.patchNodesNodes({
          name: currentName,
          updateMask,
          body: {
            displayName,
            sasUserIds: news.sasUserIds,
          },
        });
      }

      return nodeAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(sas.deleteNodesNodes({ name: output.name }));
    }),
  });
