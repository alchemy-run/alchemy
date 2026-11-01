import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import { hasServiceAccount } from "./internal/service_account.ts";

/** One claim check on the federated token. */
export interface FederatedIdentityAssertion {
  /** Claim of the external token to check, e.g. `aud`, `sub`, `email`. */
  item: string;
  /**
   * Comparison operator. STACKIT supports only `equals`.
   * @default "equals"
   */
  operator?: "equals";
  /** Value the claim must have. */
  value: string;
}

export type FederatedIdentityProviderProps = {
  /**
   * Email of the service account to federate, e.g. a
   * `Stackit.IAM.ServiceAccount`'s `email`. Changing it replaces the
   * federated identity provider.
   */
  serviceAccountEmail: string;
  /**
   * Project of the service account. Defaults to the profile's project.
   * Changing it replaces the federated identity provider.
   */
  projectId?: string;
  /**
   * Name of the federated identity provider, unique per service account.
   * If omitted, a unique name is generated from the stack, stage and
   * logical id. Changing it renames the provider in place.
   */
  name?: string;
  /**
   * Issuer URL of the external identity provider, matched against the
   * token's `iss` claim, e.g. `https://token.actions.githubusercontent.com`.
   * Updated in place.
   */
  issuer: string;
  /**
   * Claim checks a token must pass, 1-50 entries. STACKIT requires one on
   * `aud`. Updated in place.
   */
  assertions: FederatedIdentityAssertion[];
};

export type FederatedIdentityProvider = Resource<
  "Stackit.IAM.FederatedIdentityProvider",
  FederatedIdentityProviderProps,
  {
    /** Unique id of the federated identity provider (`federationId`). */
    federationId: string;
    /** Email of the federated service account. */
    serviceAccountEmail: string;
    /** Project of the service account. */
    projectId: string;
    /** Name of the federated identity provider. */
    name: string;
    /** Issuer URL of the external identity provider. */
    issuer: string;
    /** Claim checks, as STACKIT stores them. */
    assertions: Array<{ item: string; operator: string; value: string }>;
    /** Creation timestamp. */
    createdAt: string;
    /** Last update timestamp. */
    updatedAt: string;
  },
  never,
  Providers
>;

/**
 * Workload identity federation for a STACKIT service account: workloads
 * holding an OIDC token from a trusted issuer (GitHub Actions, GitLab CI,
 * a Kubernetes cluster, your own IdP) exchange it for a STACKIT access token
 * of the service account, with no long-lived key.
 *
 * Every assertion must hold for a token to be accepted. Always assert `aud`
 * (STACKIT requires it) and narrow `sub` to the workloads you trust; an
 * issuer such as GitHub signs tokens for every repository.
 *
 * Ownership: federated identity providers have no labels. Alchemy tracks a
 * provider through the `federationId` in its state; one found only by an
 * explicit `name` is reported as unowned and adopted only with `--adopt`.
 * `alchemy unsafe nuke` removes providers by deleting their service account.
 *
 * ### Federating GitHub Actions
 * **Example:** Trust one repository's main branch
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const deployer = yield* Stackit.IAM.ServiceAccount("Deployer", {});
 * yield* Stackit.IAM.FederatedIdentityProvider("GitHub", {
 *   serviceAccountEmail: deployer.email,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   assertions: [
 *     { item: "aud", value: "sts.accounts.stackit.cloud" },
 *     { item: "sub", value: "repo:my-org/my-repo:ref:refs/heads/main" },
 *   ],
 * });
 * ```
 *
 * ### Federating Another Identity Provider
 * **Example:** Trust an OIDC issuer for one identity
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const worker = yield* Stackit.IAM.ServiceAccount("Worker", {});
 * yield* Stackit.IAM.FederatedIdentityProvider("Corp", {
 *   serviceAccountEmail: worker.email,
 *   name: "corp-idp",
 *   issuer: "https://auth.example.com",
 *   assertions: [
 *     { item: "aud", operator: "equals", value: "stackit" },
 *     { item: "email", operator: "equals", value: "worker@example.com" },
 *   ],
 * });
 * ```
 *
 * ### Replacement
 * Changing `serviceAccountEmail` or `projectId` creates the provider on the
 * other service account and deletes the old one. `name`, `issuer` and
 * `assertions` update in place.
 *
 * @resource
 * @product STACKIT Service Account
 * @category IAM
 */
export const FederatedIdentityProvider = Resource<FederatedIdentityProvider>(
  "Stackit.IAM.FederatedIdentityProvider",
);

/** The federated identity provider could not be found after creating it. */
export class FederatedIdentityProviderNotResolved extends Data.TaggedError(
  "Stackit.IAM.FederatedIdentityProviderNotResolved",
)<{
  readonly resourceName: string;
  readonly serviceAccountEmail: string;
  readonly message: string;
}> {}

type Attributes = FederatedIdentityProvider["Attributes"];

const generatedName = (id: string) => createPhysicalName({ id, maxLength: 63, lowercase: true });

const desiredAssertions = (assertions: ReadonlyArray<FederatedIdentityAssertion>) =>
  assertions.map((assertion) => ({
    item: assertion.item,
    operator: assertion.operator ?? "equals",
    value: assertion.value,
  }));

const assertionKey = (assertion: { item: string; operator: string; value: string }) =>
  JSON.stringify([assertion.item, assertion.operator, assertion.value]);

/** Order-insensitive: STACKIT may return assertions in any order. */
const sameAssertions = (
  a: ReadonlyArray<{ item: string; operator: string; value: string }>,
  b: ReadonlyArray<{ item: string; operator: string; value: string }>,
) => {
  const left = a.map(assertionKey).sort();
  const right = b.map(assertionKey).sort();
  return left.length === right.length && left.every((key, i) => key === right[i]);
};

const toAttrs = (
  provider: serviceAccount.FederatedIdentityProvider,
  federationId: string,
  scope: { projectId: string; serviceAccountEmail: string },
): Attributes => ({
  federationId,
  serviceAccountEmail: scope.serviceAccountEmail,
  projectId: scope.projectId,
  name: provider.name,
  issuer: provider.issuer,
  assertions: provider.assertions.map((assertion) => ({
    item: assertion.item,
    operator: assertion.operator,
    value: assertion.value,
  })),
  createdAt: provider.createdAt,
  updatedAt: provider.updatedAt,
});

const getById = (input: { projectId: string; serviceAccountEmail: string; federationId: string }) =>
  serviceAccount
    .getFederatedIdentityProvider(input)
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * The provider with this name. The list endpoint returns one page (it takes
 * no paging parameters), which holds every provider of a service account.
 */
const findByName = (input: { projectId: string; serviceAccountEmail: string; name: string }) =>
  serviceAccount
    .listFederatedIdentityProviders({
      projectId: input.projectId,
      serviceAccountEmail: input.serviceAccountEmail,
    })
    .pipe(Effect.map((list) => list.resources.find((provider) => provider.name === input.name)));

/**
 * The live provider and its id, by recorded id first, then by name;
 * `undefined` when it or its service account is gone.
 */
const observe = Effect.fn(function* (input: {
  projectId: string;
  serviceAccountEmail: string;
  federationId?: string;
  name: string;
}) {
  const scope = { projectId: input.projectId, serviceAccountEmail: input.serviceAccountEmail };
  if (!(yield* hasServiceAccount(scope.projectId, scope.serviceAccountEmail))) return undefined;
  if (input.federationId !== undefined) {
    const byId = yield* getById({ ...scope, federationId: input.federationId });
    if (byId !== undefined) return { provider: byId, federationId: byId.id ?? input.federationId };
  }
  const byName = yield* findByName({ ...scope, name: input.name });
  if (byName?.id === undefined) return undefined;
  return { provider: byName, federationId: byName.id };
});

const deleteProvider = Effect.fn(function* (input: {
  projectId: string;
  serviceAccountEmail: string;
  federationId: string;
}) {
  const scope = { projectId: input.projectId, serviceAccountEmail: input.serviceAccountEmail };
  // Observe first: the delete endpoint documents no 404, and a deleted
  // service account took its providers with it.
  if (!(yield* hasServiceAccount(scope.projectId, scope.serviceAccountEmail))) return;
  const live = yield* getById({ ...scope, federationId: input.federationId });
  if (live === undefined) return;
  yield* serviceAccount.deleteServiceFederatedIdentityProvider({
    ...scope,
    federationId: input.federationId,
  });
});

export const FederatedIdentityProviderProvider = () =>
  Provider.succeed(FederatedIdentityProvider, {
    stables: ["federationId", "serviceAccountEmail", "projectId", "createdAt"],
    // Deleting a provider needs its service account; nuke removes providers
    // through the account (`list` is empty: no ownership marker).
    nuke: { dependsOn: ["Stackit.IAM.ServiceAccount"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Delete-first for an explicit name: the provider is found by it, and an
      // unresolved account can resolve to the current one. A generated name
      // carries the generation, so it never collides.
      if (
        hasUnresolvedTrigger<FederatedIdentityProviderProps>(news, [
          "projectId",
          "serviceAccountEmail",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<FederatedIdentityProviderProps>(news, "name") !== undefined,
        } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if (
        (news.projectId ?? env.projectId) !== output.projectId ||
        news.serviceAccountEmail !== output.serviceAccountEmail
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const serviceAccountEmail = output?.serviceAccountEmail ?? olds?.serviceAccountEmail;
      if (serviceAccountEmail === undefined) return undefined;
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* observe({
        projectId,
        serviceAccountEmail,
        federationId: output?.federationId,
        name,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found.provider, found.federationId, {
        projectId,
        serviceAccountEmail,
      });
      return found.federationId === output?.federationId ||
        found.federationId === previous?.federationId ||
        name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const serviceAccountEmail = news.serviceAccountEmail;
      const scope = { projectId, serviceAccountEmail };
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const assertions = desiredAssertions(news.assertions);
      const sameScope =
        output?.projectId === projectId && output?.serviceAccountEmail === serviceAccountEmail;

      // Observe: the recorded provider, or one with this name.
      let current = yield* observe({
        ...scope,
        federationId: sameScope ? output?.federationId : undefined,
        name,
      });

      // Ensure. A conflict is a provider with this name created concurrently.
      if (current === undefined) {
        const created = yield* serviceAccount
          .createFederatedIdentityProvider({ ...scope, name, issuer: news.issuer, assertions })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        current =
          created?.id !== undefined
            ? { provider: created, federationId: created.id }
            : yield* observe({ ...scope, name });
        // A provider this resource made on another service account would
        // otherwise be left behind.
        if (output !== undefined && !sameScope) {
          yield* deleteProvider(output);
        }
      }
      if (current === undefined) {
        return yield* new FederatedIdentityProviderNotResolved({
          resourceName: name,
          serviceAccountEmail,
          message: `STACKIT federated identity provider '${name}' was not found on ${serviceAccountEmail} after creating it`,
        });
      }

      // Sync name, issuer and assertions against the observed provider.
      const observed = current.provider;
      if (
        observed.name !== name ||
        observed.issuer !== news.issuer ||
        !sameAssertions(observed.assertions, assertions)
      ) {
        const updated = yield* serviceAccount.partialUpdateServiceAccountFederatedIdentityProvider({
          ...scope,
          federationId: current.federationId,
          name,
          issuer: news.issuer,
          assertions,
        });
        current = { provider: updated, federationId: current.federationId };
      }

      return toAttrs(current.provider, current.federationId, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteProvider(output);
    }),
  });
