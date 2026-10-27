import * as Entire from "@distilled.cloud/entire";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient, retryPropagation, slugName, waitUntilGone } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type ServiceAccountProps = {
  /** ID of the org that owns the service account. Changing it replaces the account. */
  orgId: string;
  /**
   * Name, unique in the org. Changing it replaces the account.
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
};

export type ServiceAccount = Resource<
  "Entire.ServiceAccount",
  ServiceAccountProps,
  {
    /** Service account ID (ULID); the `accountId` grants and OIDC bindings take. */
    accountId: string;
    /** Name. */
    name: string;
    /** ID of the owning org. */
    orgId: string;
    /** Lifecycle status. */
    status: string;
    /** When the account was created. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A non-human Entire identity owned by an {@link Org}, for CI and other
 * automation. A service account has no password or key: workloads sign in
 * by exchanging an OIDC token from a trusted issuer (GitHub Actions,
 * Buildkite, Depot) for an Entire session, which an {@link OidcBinding}
 * allows. Grant it access to projects and repositories with
 * {@link ServiceAccountGrant}.
 *
 * ### Creating a Service Account
 * **Example:** A CI identity that GitHub Actions can assume
 * ```typescript
 * const org = yield* Entire.Org("acme", { name: "acme" });
 * const ci = yield* Entire.ServiceAccount("ci", { orgId: org.id });
 *
 * yield* Entire.OidcBinding("ci-github", {
 *   accountId: ci.accountId,
 *   provider: "github-actions",
 *   attributeFilter: { repository: "acme/api" },
 * });
 *
 * yield* Entire.ServiceAccountGrant("ci-writes-api", {
 *   accountId: ci.accountId,
 *   resourceType: "repo",
 *   resourceId: repo.id,
 *   role: "writer",
 * });
 * ```
 *
 * @resource
 * @product ServiceAccount
 */
export const ServiceAccount = Resource<ServiceAccount>("Entire.ServiceAccount");

const toAttrs = (sa: Entire.serviceAccounts.ServiceAccount) => ({
  accountId: sa.accountId,
  name: sa.name,
  orgId: sa.orgId,
  status: sa.status,
  createdAt: sa.createdAt,
});

export const ServiceAccountProvider = () =>
  Provider.effect(
    ServiceAccount,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const accountName = (id: string, props: { name?: string }) =>
        props.name ? Effect.succeed(props.name) : slugName(id);

      const get = (accountId: string) =>
        client.core(Entire.serviceAccounts.getServiceAccount({ accountId }));

      const findByName = (orgId: string, name: string) =>
        client.core(
          Entire.serviceAccounts.listServiceAccounts.items({ orgId }).pipe(
            Stream.filter((sa) => sa.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );

      return {
        stables: ["accountId", "orgId", "createdAt"],
        // Service accounts carry no labels; see Project.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (news.orgId !== output.orgId) return { action: "replace" } as const;
          if ((yield* accountName(id, news)) !== output.name) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.accountId) {
            const sa = yield* get(output.accountId).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
            return sa ? toAttrs(sa) : undefined;
          }
          if (!olds?.orgId) return undefined;
          const found = yield* findByName(olds.orgId, yield* accountName(id, olds));
          return found ? Unowned(toAttrs(found)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* accountName(id, news);
          const observed = output?.accountId
            ? yield* get(output.accountId).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : yield* findByName(news.orgId, name);
          if (observed) return toAttrs(observed);
          return toAttrs(
            yield* client
              .core(Entire.serviceAccounts.createServiceAccount({ orgId: news.orgId, name }))
              .pipe(retryPropagation),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(Entire.serviceAccounts.deleteServiceAccount({ accountId: output.accountId }))
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* waitUntilGone(get(output.accountId), `service account ${output.name}`);
        }),
      };
    }),
  );
