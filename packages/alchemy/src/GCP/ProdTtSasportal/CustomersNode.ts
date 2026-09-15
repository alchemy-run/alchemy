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
  expandCustomer,
  findOwned,
  getCustomerNode,
  hasOwnershipMarker,
  ignoreMissing,
  listAllCustomerNodes,
  listCustomerNodes,
  nodeAttrs,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameStringList,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type CustomersNodeProps = {
  /**
   * Parent SAS customer (`customers/{customer}` or the customer id).
   * Immutable — changing it replaces the node.
   */
  customer: string;
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

export type CustomersNode = Resource<
  "GCP.ProdTtSasportal.CustomersNode",
  CustomersNodeProps,
  {
    /** Full resource name `customers/{customer}/nodes/{node}`. */
    name: string;
    /** Parent customer resource name. */
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
 * A Spectrum Access System (SAS) Portal node under a customer in the
 * production-test (prod-tt) environment.
 *
 * Nodes have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent customer and resource name
 * are identity. Display name and SAS user ids update in place.
 *
 * ### Creating a Node
 * **Example:** Named node under a customer
 * ```typescript
 * const node = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
 *   customer: "customers/123",
 *   displayName: "north-campus",
 * });
 * ```
 *
 * ### Updating a Node
 * **Example:** Change the display name
 * ```typescript
 * const node = yield* GCP.ProdTtSasportal.CustomersNode("Campus", {
 *   customer: existing.parent,
 *   name: existing.name,
 *   displayName: "south-campus",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const CustomersNode = Resource<CustomersNode>(
  "GCP.ProdTtSasportal.CustomersNode",
);

export class CustomersNodeNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.CustomersNodeNotResolved",
)<{
  name: string;
}> {}

export const CustomersNodeProvider = () =>
  Provider.succeed(CustomersNode, {
    stables: ["name", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.customer ?? output?.parent;
      return replaceOnIdentity({
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
        previousParent: previousParent
          ? expandCustomer(previousParent)
          : undefined,
        nextParent: expandCustomer(news.customer),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const parent = expandCustomer(olds?.customer ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getCustomerNode(name);
      if (existing === undefined) {
        existing = yield* findOwned(yield* listCustomerNodes(parent), id);
      }
      if (existing === undefined) return undefined;
      const attrs = nodeAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllCustomerNodes();
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => nodeAttrs(item, ""));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = expandCustomer(news.customer);
      const name = news.name ?? output?.name ?? "";
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName),
      );

      let current = yield* getCustomerNode(name);
      if (current === undefined) {
        current = yield* findOwned(yield* listCustomerNodes(parent), id);
      }

      if (current === undefined) {
        const created = yield* sas
          .createCustomersNodes({
            parent,
            body: {
              displayName,
              sasUserIds: news.sasUserIds,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listCustomerNodes(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersNodeNotResolved({
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
        current = yield* sas.patchCustomersNodes({
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
      yield* ignoreMissing(sas.deleteCustomersNodes({ name: output.name }));
    }),
  });
