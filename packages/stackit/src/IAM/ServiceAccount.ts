import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import type { Providers } from "../Providers.ts";
import { listServiceAccounts } from "./internal/service_account.ts";

export type ServiceAccountProps = {
  /**
   * Requested name of the service account. STACKIT appends a random suffix
   * and a domain to build the account's email
   * (`<name>-<suffix>@sa.stackit.cloud`). 1-20 characters: lowercase
   * letters, digits and single dashes, starting with a letter and not ending
   * with a dash.
   *
   * If omitted, a unique name is generated from the logical id and the
   * resource's instance id (`<id prefix>-<16 chars>`), which is also how
   * Alchemy recognizes its own service accounts (see the resource docs).
   * Changing it replaces the service account.
   */
  name?: string;
  /**
   * Project the service account lives in. Defaults to the profile's
   * project. Changing it replaces the service account.
   */
  projectId?: string;
};

export type ServiceAccount = Resource<
  "Stackit.IAM.ServiceAccount",
  ServiceAccountProps,
  {
    /**
     * Unique id (UUID) of the service account. It is the `sub` claim of the
     * account's access tokens.
     */
    id: string;
    /**
     * Email of the service account (`<name>-<suffix>@sa.stackit.cloud`), its
     * identifier in every other STACKIT API (keys, role assignments).
     */
    email: string;
    /** Requested name the email was built from. */
    name: string;
    /** Project the service account lives in. */
    projectId: string;
    /** Whether STACKIT flags the account as internal (service-managed). */
    internal: boolean;
  },
  never,
  Providers
>;

/**
 * A STACKIT service account: a machine identity that lives in one project
 * and authenticates with service account keys (see
 * `Stackit.IAM.ServiceAccountKey`) or workload identity federation (see
 * `Stackit.IAM.FederatedIdentityProvider`).
 *
 * A new service account has no permissions. Grant it roles on the project,
 * another project of the organization, or the organization itself with the
 * IAM role-assignment resources.
 *
 * Ownership: service accounts have no labels or description, so Alchemy
 * marks its own through the generated name: an account without an explicit
 * `name` is named `<id prefix>-<16 chars of the instance id>`. `alchemy
 * unsafe nuke` enumerates only accounts with such a name. An account with
 * an explicit `name` that already exists in the project is reported as
 * unowned and adopted only with `--adopt`.
 *
 * ### Creating a Service Account
 * **Example:** Generated name in the profile's project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * // ci.email -> "ci-…@sa.stackit.cloud"
 * ```
 *
 * **Example:** Explicit name in another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const deployer = yield* Stackit.IAM.ServiceAccount("Deployer", {
 *   name: "deployer",
 *   projectId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * ### Giving the Account a Key
 * **Example:** Service account with a STACKIT-generated key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * const key = yield* Stackit.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccountEmail: ci.email,
 * });
 * // key.keyJson is the key file STACKIT's CLI, SDKs and Terraform read.
 * ```
 *
 * ### Replacement
 * Changing `name` or `projectId` creates a new service account (with a new
 * email) and deletes the old one. Keys, federated identity providers and
 * role assignments bound to the old email go with it, so pass `email` to
 * them as an output and they are recreated against the new account.
 *
 * **Example:** Renaming creates a new account
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // was: { name: "deployer" }
 * const deployer = yield* Stackit.IAM.ServiceAccount("Deployer", {
 *   name: "deployer-v2",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Service Account
 * @category IAM
 */
export const ServiceAccount = Resource<ServiceAccount>("Stackit.IAM.ServiceAccount");

/** The service account could not be found right after creating it. */
export class ServiceAccountNotResolved extends Data.TaggedError(
  "Stackit.IAM.ServiceAccountNotResolved",
)<{ readonly resourceName: string; readonly projectId: string; readonly message: string }> {}

type Attributes = ServiceAccount["Attributes"];

/**
 * `<id prefix>-<16 chars>`: exactly 20 characters at most, the API's limit,
 * and shaped so `isGeneratedPhysicalName` recognizes it.
 */
const generatedName = (id: string) =>
  Effect.gen(function* () {
    const base =
      id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^[^a-z]+/, "")
        .slice(0, 3)
        .replace(/-+$/, "") || "sa";
    return yield* createPhysicalName({
      id,
      prefix: `${base}-`,
      suffixLength: 16,
      maxLength: 20,
      lowercase: true,
    });
  });

/**
 * The requested name an email was built from:
 * `<name>-<suffix>@sa.stackit.cloud` -> `<name>`.
 */
export const serviceAccountNameOf = (email: string): string => {
  const local = email.slice(0, Math.max(0, email.indexOf("@")));
  const dash = local.lastIndexOf("-");
  return dash > 0 ? local.slice(0, dash) : local;
};

const toAttrs = (account: serviceAccount.ServiceAccount2, name: string): Attributes => ({
  id: account.id,
  email: account.email,
  name,
  projectId: account.projectId,
  internal: account.internal,
});

/** Find the account by its email, else by the name its email was built from. */
const observe = Effect.fn(function* (input: { projectId: string; email?: string; name: string }) {
  const accounts = yield* listServiceAccounts(input.projectId);
  return (
    (input.email === undefined
      ? undefined
      : accounts.find((account) => account.email === input.email)) ??
    accounts.find((account) => serviceAccountNameOf(account.email) === input.name)
  );
});

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, {
    stables: ["id", "email", "name", "projectId", "internal"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      if ((news.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace" as const };
      }
      // An unset name keeps the generated one; dropping an explicit name
      // switches to a generated one, which is a rename.
      const desiredName = news.name ?? (olds?.name === undefined ? output.name : undefined);
      if (desiredName !== output.name) return { action: "replace" as const };
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* observe({ projectId, email: output?.email, name });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, name);
      // Our recorded email, or our generated (instance-id-bearing) name, is
      // ours; a match on a user-chosen name may belong to someone else.
      return found.email === output?.email || name === generated ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* StackitEnvironment.current;
        const accounts = yield* listServiceAccounts(env.projectId);
        return accounts
          .filter(
            (account) =>
              !account.internal && isGeneratedPhysicalName(serviceAccountNameOf(account.email)),
          )
          .map((account) => toAttrs(account, serviceAccountNameOf(account.email)));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const sameIdentity = output?.projectId === projectId && output?.name === name;

      // Observe: the recorded account, or one a crashed run created.
      let current = yield* observe({
        projectId,
        email: sameIdentity ? output?.email : undefined,
        name,
      });

      // Ensure. A conflict is a concurrent create of the same name.
      if (current === undefined) {
        current = yield* serviceAccount
          .createServiceAccount({ projectId, name })
          .pipe(Effect.catchTag("Conflict", () => observe({ projectId, name })));
      }
      if (current === undefined) {
        return yield* new ServiceAccountNotResolved({
          resourceName: name,
          projectId,
          message: `STACKIT service account '${name}' was not found in project ${projectId} after creating it`,
        });
      }

      // Nothing to sync: a service account has no mutable fields.
      return toAttrs(current, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting the account also deletes its keys and federations.
      yield* serviceAccount
        .deleteServiceAccount({
          projectId: output.projectId,
          serviceAccountEmail: output.email,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
