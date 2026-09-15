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
  listAllNodeNodeNodes,
  listNodeNodesNodes,
  nodeAttrs,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameStringList,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type NodesNodesNodeProps = {
  /**
   * Parent nested SAS node (`nodes/{node}/nodes/{node}` or a customer-nested node name).
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

export type NodesNodesNode = Resource<
  "GCP.ProdTtSasportal.NodesNodesNode",
  NodesNodesNodeProps,
  {
    /** Full resource name. */
    name: string;
    /** Parent resource name. */
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
 * A nested Spectrum Access System (SAS) Portal node under another nested node in the production-test (prod-tt) environment.
 *
 * Nodes have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent and resource name are
 * identity. Display name and SAS user ids update in place.
 *
 * ### Creating a Nested Node
 * **Example:** Child node
 * ```typescript
 * const child = yield* GCP.ProdTtSasportal.NodesNodesNode("Building", {
 *   node: child.name,
 *   displayName: "floor-3",
 * });
 * ```
 *
 * ### Updating a Nested Node
 * **Example:** Change the display name
 * ```typescript
 * const child = yield* GCP.ProdTtSasportal.NodesNodesNode("Building", {
 *   node: existing.parent,
 *   name: existing.name,
 *   displayName: "floor-4",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const NodesNodesNode = Resource<NodesNodesNode>(
  "GCP.ProdTtSasportal.NodesNodesNode",
);

export class NodesNodesNodeNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.NodesNodesNodeNotResolved",
)<{
  name: string;
}> {}

export const NodesNodesNodeProvider = () =>
  Provider.succeed(NodesNodesNode, {
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
        existing = yield* findOwned(yield* listNodeNodesNodes(parent), id);
      }
      if (existing === undefined) return undefined;
      const attrs = nodeAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllNodeNodeNodes();
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
        current = yield* findOwned(yield* listNodeNodesNodes(parent), id);
      }

      if (current === undefined) {
        const created = yield* sas
          .createNodesNodesNodes({
            parent,
            body: {
              displayName,
              sasUserIds: news.sasUserIds,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listNodeNodesNodes(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NodesNodesNodeNotResolved({
          name: name || parent,
        });
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
