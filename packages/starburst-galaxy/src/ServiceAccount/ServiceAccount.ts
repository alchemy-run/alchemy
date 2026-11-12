import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { ServiceAccount as ServiceAccountShape } from "@distilled.cloud/starburst-galaxy/service_account";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  collectAll,
  findFirst,
  isGeneratedName,
  ownership,
  physicalName,
  sameIds,
  SERVICE_ACCOUNT_NAME,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface ServiceAccountProps {
  /**
   * The service account's user name, which Trino clients log in with.
   * Galaxy cannot rename a service account: changing it replaces the
   * account and its passwords.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /**
   * ID of the role the account's sessions start in (a `Role`'s `roleId`).
   * @default Galaxy's default for new service accounts
   */
  readonly role?: string;
  /**
   * IDs of further roles the account holds and can `SET ROLE` to.
   * @default []
   */
  readonly additionalRoles?: ReadonlyArray<string>;
}

export interface ServiceAccountAttributes {
  /** Galaxy's service account ID. */
  readonly serviceAccountId: string;
  /** The service account's name, as it was created (without the account domain). */
  readonly name: string;
  /**
   * The user name Trino clients log in with: Galaxy qualifies the name with
   * the account domain (`<name>@<account>.galaxy.starburst.io`).
   */
  readonly userName: string;
  /** ID of the default role. */
  readonly roleId: string;
  /** IDs of the additional roles. */
  readonly additionalRoleIds: ReadonlyArray<string>;
}

/** Find a service account this stack doesn't manage by its user name. */
export interface ServiceAccountLookup {
  /** Service account user name. */
  readonly name: string;
}

export type ServiceAccount = Resource<
  "StarburstGalaxy.ServiceAccount",
  ServiceAccountProps,
  ServiceAccountAttributes,
  never,
  Providers,
  ServiceAccountLookup
>;

/**
 * A Starburst Galaxy service account: a non-human principal that Trino
 * clients (BI tools, jobs, applications) log in as. Its access is the
 * privileges of its roles; its credentials are
 * `StarburstGalaxy.ServiceAccountPassword`s, which rotate independently
 * of the account.
 *
 * The account is created without an initial password. Roles update in
 * place; the user name cannot change, so a new `name` replaces the account.
 * Service accounts have no labels or tags in Galaxy: an account Alchemy
 * created is recognized by its generated user name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security/service-accounts.html
 *
 * ### Creating a service account
 * **Example:** A reporting login with its own role and password
 * ```typescript
 * const reporting = yield* StarburstGalaxy.Role("Reporting", {});
 * const account = yield* StarburstGalaxy.ServiceAccount("Reporter", {
 *   role: reporting.roleId,
 * });
 * const password = yield* StarburstGalaxy.ServiceAccountPassword("ReporterPassword", {
 *   serviceAccount: account.serviceAccountId,
 * });
 * // Log in to the cluster's trinoUri as account.userName with password.trinoPassword.
 * ```
 *
 * ### Holding several roles
 * **Example:** A default role plus roles to switch to
 * ```typescript
 * const reader = yield* StarburstGalaxy.Role("Reader", {});
 * const writer = yield* StarburstGalaxy.Role("Writer", {});
 * yield* StarburstGalaxy.ServiceAccount("Etl", {
 *   role: reader.roleId,
 *   additionalRoles: [writer.roleId],
 * });
 * ```
 *
 * ### Looking up an existing service account
 * **Example:** Reference an account created in the Galaxy console
 * ```typescript
 * const bi = StarburstGalaxy.ServiceAccount.lookup({ name: "bi_tool" });
 * ```
 *
 * @resource
 * @product Access control
 */
export const ServiceAccount = Resource<ServiceAccount>("StarburstGalaxy.ServiceAccount");

/** Galaxy accepted a service account create but the account could not be read back. */
export class ServiceAccountNotResolved extends Data.TaggedError(
  "StarburstGalaxy.ServiceAccountNotResolved",
)<{
  readonly userName: string;
}> {
  override get message() {
    return `Service account ${this.userName} could not be found after it was created`;
  }
}

/** Galaxy reports `<name>@<account domain>`; the part before the `@` is the name it was created with. */
const nameOf = (userName: string) => {
  const at = userName.lastIndexOf("@");
  return at === -1 ? userName : userName.slice(0, at);
};

const toAttributes = (account: ServiceAccountShape): ServiceAccountAttributes => ({
  serviceAccountId: account.serviceAccountId,
  name: nameOf(account.userName),
  userName: account.userName,
  roleId: account.roleId,
  additionalRoleIds: account.additionalRoleIds,
});

const getAccount = (serviceAccountId: string) =>
  galaxy.serviceAccount
    .getServiceAccount({ serviceAccountId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(
    galaxy.serviceAccount.listServiceAccounts.items({}),
    (account) => account.userName === name || nameOf(account.userName) === name,
  );

const observe = Effect.fn(function* (serviceAccountId: string | undefined, name: string) {
  if (serviceAccountId !== undefined) {
    const byId = yield* getAccount(serviceAccountId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, {
    stables: ["serviceAccountId", "name"],

    nuke: {
      // The account names its roles; delete accounts before roles.
      dependsOn: ["StarburstGalaxy.Role"],
    },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // Galaxy has no rename: a new user name is a new account.
      if (news.name !== undefined && output !== undefined && news.name !== output.name) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, SERVICE_ACCOUNT_NAME));
      const account = yield* observe(output?.serviceAccountId, name);
      if (account === undefined) return undefined;
      return ownership(toAttributes(account), {
        output,
        explicitName: olds?.name,
        previous,
        key: "serviceAccountId",
      });
    }),

    lookup: Effect.fn(function* ({ name }) {
      const account = yield* findByName(name);
      return account === undefined ? undefined : toAttributes(account);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = output?.name ?? (yield* physicalName(id, news.name, SERVICE_ACCOUNT_NAME));
      const additionalRoleIds = [...(news.additionalRoles ?? [])];

      // Observe
      let account = yield* observe(output?.serviceAccountId, name);

      // Ensure: passwords are separate resources, so none is created here.
      if (account === undefined) {
        yield* session.note(`Creating service account ${name}...`);
        const created = yield* galaxy.serviceAccount
          .createServiceAccount({
            username: name,
            roleId: news.role,
            additionalRoleIds,
            withInitialPassword: false,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        account = created ?? (yield* findByName(name));
      }
      if (account === undefined) {
        return yield* new ServiceAccountNotResolved({ userName: name });
      }

      // Sync: the default role and the additional roles, as sets.
      const roleChanged = news.role !== undefined && news.role !== account.roleId;
      const rolesChanged = !sameIds(account.additionalRoleIds, additionalRoleIds);
      if (roleChanged || rolesChanged) {
        yield* session.note(`Updating the roles of service account ${name}...`);
        account = yield* galaxy.serviceAccount.updateServiceAccount({
          serviceAccountId: account.serviceAccountId,
          ...(roleChanged ? { roleId: news.role } : {}),
          ...(rolesChanged ? { additionalRoleIds } : {}),
        });
      }

      return toAttributes(account);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.serviceAccount
        .deleteServiceAccount({ serviceAccountId: output.serviceAccountId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.serviceAccount.listServiceAccounts
          .items({})
          .pipe(Stream.filter((item) => isGeneratedName(nameOf(item.userName)))),
        toAttributes,
      ),
  });
