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
  expandCustomer,
  findOwned,
  getCustomerDeployment,
  hasOwnershipMarker,
  ignoreMissing,
  listAllCustomerDeployments,
  listCustomerDeployments,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameStringList,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type CustomersDeploymentProps = {
  /**
   * Parent SAS customer (`customers/{customer}` or the customer id).
   * Immutable — changing it replaces the deployment.
   */
  customer: string;
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

export type CustomersDeployment = Resource<
  "GCP.ProdTtSasportal.CustomersDeployment",
  CustomersDeploymentProps,
  {
    /** Full resource name `customers/{customer}/deployments/{deployment}`. */
    name: string;
    /** Parent customer resource name. */
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
 * A Spectrum Access System (SAS) Portal deployment under a customer in
 * the production-test (prod-tt) environment.
 *
 * Deployments have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent customer and resource name
 * are identity. Display name and SAS user ids update in place.
 *
 * ### Creating a Deployment
 * **Example:** Named deployment under a customer
 * ```typescript
 * const deployment = yield* GCP.ProdTtSasportal.CustomersDeployment(
 *   "Site",
 *   {
 *     customer: "customers/123",
 *     displayName: "downtown",
 *     sasUserIds: ["user-1"],
 *   },
 * );
 * ```
 *
 * ### Updating a Deployment
 * **Example:** Change the display name
 * ```typescript
 * const deployment = yield* GCP.ProdTtSasportal.CustomersDeployment(
 *   "Site",
 *   {
 *     customer: existing.parent,
 *     name: existing.name,
 *     displayName: "uptown",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const CustomersDeployment = Resource<CustomersDeployment>(
  "GCP.ProdTtSasportal.CustomersDeployment",
);

export class CustomersDeploymentNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.CustomersDeploymentNotResolved",
)<{
  name: string;
}> {}

export const CustomersDeploymentProvider = () =>
  Provider.succeed(CustomersDeployment, {
    stables: ["name", "parent", "frns"],

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
      let existing = yield* getCustomerDeployment(name);
      if (existing === undefined) {
        existing = yield* findOwned(yield* listCustomerDeployments(parent), id);
      }
      if (existing === undefined) return undefined;
      const attrs = deploymentAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllCustomerDeployments();
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => deploymentAttrs(item, ""));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = expandCustomer(news.customer);
      const name = news.name ?? output?.name ?? "";
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName),
      );

      let current = yield* getCustomerDeployment(name);
      if (current === undefined) {
        current = yield* findOwned(yield* listCustomerDeployments(parent), id);
      }

      if (current === undefined) {
        const created = yield* sas
          .createCustomersDeployments({
            parent,
            body: {
              displayName,
              sasUserIds: news.sasUserIds,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listCustomerDeployments(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersDeploymentNotResolved({
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
        current = yield* sas.patchCustomersDeployments({
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
      yield* ignoreMissing(
        sas.deleteCustomersDeployments({ name: output.name }),
      );
    }),
  });
