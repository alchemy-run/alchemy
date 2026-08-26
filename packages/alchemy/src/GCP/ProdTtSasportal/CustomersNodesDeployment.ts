import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  deploymentAttrs,
  encodeOwnershipLine,
  expandNode,
  findOwned,
  getNodeDeployment,
  hasOwnershipMarker,
  ignoreMissing,
  listAllCustomerNodeDeployments,
  listCustomerNodesDeployments,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameStringList,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type CustomersNodesDeploymentProps = {
  /**
   * Parent SAS customer node (`customers/{customer}/nodes/{node}`).
   * Immutable — changing it replaces the deployment.
   */
  node: string;
  /**
   * Full resource name. Server-assigned on create. Immutable — changing
   * it replaces the deployment.
   */
  name?: string;
  /**
   * Human-readable name. Deployments have no labels field, so Alchemy
   * stamps ownership into this field.
   */
  displayName?: string;
  /**
   * User IDs used by devices belonging to this deployment.
   */
  sasUserIds?: string[];
};

export type CustomersNodesDeployment = Resource<
  "GCP.ProdTtSasportal.CustomersNodesDeployment",
  CustomersNodesDeploymentProps,
  {
    /** Full resource name. */
    name: string;
    /** Parent resource name. */
    parent: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** User IDs used by devices in this deployment. */
    sasUserIds: string[];
    /** FCC Registration Numbers copied from the parent. */
    frns: string[];
  },
  never,
  Providers
>;

/**
 * A Spectrum Access System (SAS) Portal deployment under a customer node in the production-test (prod-tt) environment.
 *
 * Deployments have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent and resource name are
 * identity. Display name and SAS user ids update in place.
 *
 * ### Creating a Deployment
 * **Example:** Named deployment
 * ```typescript
 * const deployment = yield* GCP.ProdTtSasportal.CustomersNodesDeployment("Site", {
 *   node: node.name,
 *   displayName: "downtown",
 *   sasUserIds: ["user-1"],
 * });
 * ```
 *
 * ### Updating a Deployment
 * **Example:** Change the display name
 * ```typescript
 * const deployment = yield* GCP.ProdTtSasportal.CustomersNodesDeployment("Site", {
 *   node: existing.parent,
 *   name: existing.name,
 *   displayName: "uptown",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const CustomersNodesDeployment = Resource<CustomersNodesDeployment>(
  "GCP.ProdTtSasportal.CustomersNodesDeployment",
);

export class CustomersNodesDeploymentNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.CustomersNodesDeploymentNotResolved",
)<{
  name: string;
}> {}

export const CustomersNodesDeploymentProvider = () =>
  Provider.succeed(CustomersNodesDeployment, {
    stables: ["name", "parent", "frns"],

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
      let existing = yield* getNodeDeployment(name);
      if (existing === undefined) {
        existing = yield* findOwned(
          yield* listCustomerNodesDeployments(parent),
          id,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = deploymentAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllCustomerNodeDeployments();
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => deploymentAttrs(item, ""));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = expandNode(news.node);
      const name = news.name ?? output?.name ?? "";
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName),
      );

      let current = yield* getNodeDeployment(name);
      if (current === undefined) {
        current = yield* findOwned(
          yield* listCustomerNodesDeployments(parent),
          id,
        );
      }

      if (current === undefined) {
        const created = yield* sas
          .createCustomersNodesDeployments({
            parent,
            body: {
              displayName,
              sasUserIds: news.sasUserIds,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listCustomerNodesDeployments(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersNodesDeploymentNotResolved({
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
        current = yield* sas.patchNodesDeployments({
          name: currentName,
          updateMask,
          body: {
            displayName,
            sasUserIds: news.sasUserIds,
          },
        });
      }

      return deploymentAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(sas.deleteNodesDeployments({ name: output.name }));
    }),
  });
