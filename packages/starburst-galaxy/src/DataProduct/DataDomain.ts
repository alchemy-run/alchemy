import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { DataDomain as DataDomainShape } from "@distilled.cloud/starburst-galaxy/data_domain";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  changedFields,
  collectAll,
  DATA_DOMAIN_NAME,
  findFirst,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface DataDomainProps {
  /**
   * Domain name. Galaxy cannot rename a domain: changing it replaces the domain.
   * @default generated from the stack, logical id and stage (lowercase, `-`-delimited)
   */
  readonly name?: string;
  /**
   * Long-form description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /** Galaxy user ID of the domain's contact. */
  readonly contactUserId?: string;
  /**
   * ID of the role that owns the domain (a `Role`'s `roleId`).
   * @default the deploying client's role
   */
  readonly owningRole?: string;
}

export interface DataDomainAttributes {
  /** Galaxy's data domain ID. */
  readonly dataDomainId: string;
  /** Domain name. */
  readonly name: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /** The contact's user ID, when set. */
  readonly contactUserId: string | undefined;
  /** The contact's email, when set. */
  readonly contactEmail: string | undefined;
  /** ID of the owning role. */
  readonly owningRoleId: string;
  /** Name of the owning role. */
  readonly owningRoleName: string;
  /** IDs of the data products assigned to the domain. */
  readonly dataProductIds: ReadonlyArray<string>;
  /** Creation time. */
  readonly createdOn: string;
  /** Last modification time. */
  readonly modifiedOn: string;
}

export type DataDomain = Resource<
  "StarburstGalaxy.DataProduct.DataDomain",
  DataDomainProps,
  DataDomainAttributes,
  never,
  Providers
>;

/**
 * A Starburst Galaxy data domain: a group of data products with an owning
 * role and a contact, for organizing products by business area.
 *
 * The description, contact and owner update in place; a new name replaces
 * the domain. Galaxy refuses to delete a domain that still holds data
 * products; a delete waits briefly for the stack's own products to go.
 * The account's default domain is never listed or deleted. Galaxy marks
 * the data domain API as beta.
 *
 * @see https://docs.starburst.io/starburst-galaxy/data-products/index.html
 *
 * ### Creating a data domain
 * **Example:** A domain owned by a team role
 * ```typescript
 * const finance = yield* StarburstGalaxy.Role.Role("Finance", {});
 * const domain = yield* StarburstGalaxy.DataProduct.DataDomain("Finance", {
 *   description: "Revenue, billing and forecasting data products",
 *   owningRole: finance.roleId,
 * });
 * ```
 *
 * **Example:** A domain with a contact
 * ```typescript
 * yield* StarburstGalaxy.DataProduct.DataDomain("Sales", {
 *   name: "Sales",
 *   contactUserId: "u-1234567890",
 * });
 * ```
 *
 * @resource
 * @product Data products
 */
export const DataDomain = Resource<DataDomain>("StarburstGalaxy.DataProduct.DataDomain");

/** Galaxy accepted a data domain create but the domain could not be read back. */
export class DataDomainNotResolved extends Data.TaggedError(
  "StarburstGalaxy.DataDomainNotResolved",
)<{
  readonly domainName: string;
}> {
  override get message() {
    return `Data domain ${this.domainName} could not be found after it was created`;
  }
}

const toAttributes = (domain: DataDomainShape): DataDomainAttributes => ({
  dataDomainId: domain.dataDomainId,
  name: domain.name,
  description: domain.description,
  contactUserId: domain.contact?.userId,
  contactEmail: domain.contact?.email,
  owningRoleId: domain.owningRole.roleId,
  owningRoleName: domain.owningRole.roleName,
  dataProductIds: domain.assignedDataProducts.map((product) => product.dataProductId),
  createdOn: domain.createdOn,
  modifiedOn: domain.modifiedOn,
});

const getDomain = (dataDomainId: string) =>
  galaxy.dataDomain
    .getDataDomain({ dataDomainId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.dataDomain.listDataDomains.items({}), (domain) => domain.name === name);

const observe = Effect.fn(function* (dataDomainId: string | undefined, name: string) {
  if (dataDomainId !== undefined) {
    const byId = yield* getDomain(dataDomainId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const DataDomainProvider = () =>
  Provider.succeed(DataDomain, {
    stables: ["dataDomainId", "name", "createdOn"],

    nuke: {
      // A domain is owned by a role; delete domains before roles.
      dependsOn: ["StarburstGalaxy.Role.Role"],
    },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // Galaxy cannot rename a domain.
      if (news.name !== undefined && output !== undefined && news.name !== output.name) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, DATA_DOMAIN_NAME));
      const domain = yield* observe(output?.dataDomainId, name);
      if (domain === undefined) return undefined;
      return ownership(toAttributes(domain), {
        output,
        explicitName: olds?.name,
        previous,
        key: "dataDomainId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = output?.name ?? (yield* physicalName(id, news.name, DATA_DOMAIN_NAME));

      // Observe
      let domain = yield* observe(output?.dataDomainId, name);

      // Ensure
      if (domain === undefined) {
        yield* session.note(`Creating data domain ${name}...`);
        const created = yield* galaxy.dataDomain
          .createDataDomain({
            name,
            description: news.description,
            contactUserId: news.contactUserId,
            roleId: news.owningRole,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        domain = created ?? (yield* findByName(name));
      }
      if (domain === undefined) {
        return yield* new DataDomainNotResolved({ domainName: name });
      }

      // Sync: description, contact and owner. Galaxy's PATCH ignores absent
      // fields, so a removed contact or owner keeps its current value.
      const delta = changedFields(
        {
          description: domain.description ?? "",
          contactUserId: domain.contact?.userId,
          roleId: domain.owningRole.roleId,
        },
        {
          description: news.description ?? "",
          contactUserId: news.contactUserId,
          roleId: news.owningRole,
        },
      );
      if (hasChanges(delta)) {
        yield* session.note(`Updating data domain ${name}...`);
        domain = yield* galaxy.dataDomain.updateDataDomain({
          ...delta,
          dataDomainId: domain.dataDomainId,
        });
      }

      return toAttributes(domain);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.dataDomain.deleteDataDomain({ dataDomainId: output.dataDomainId }).pipe(
        // `PreconditionFailed`: products remain. The stack's own products are
        // deleted first and may take a moment to leave; a foreign product
        // keeps failing and is reported.
        Effect.retry({
          while: (error) => error._tag === "PreconditionFailed",
          schedule: Schedule.spaced("5 seconds"),
          times: 6,
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),

    // The account's default domain is not ours to delete.
    list: () =>
      galaxy.dataDomain.listDataDomains.items({}).pipe(
        Stream.filter((domain) => !domain.isDefault && isGeneratedName(domain.name)),
        (domains) => collectAll(domains, toAttributes),
      ),
  });
