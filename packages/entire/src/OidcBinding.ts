import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type OidcBindingProps = {
  /** The service account's `accountId`. Changing it replaces the binding. */
  accountId: string;
  /**
   * The trusted OIDC issuer, by display name (`github-actions`,
   * `buildkite`, `depot-alpha`) or by provider ID (`wip_…`). Changing it
   * replaces the binding.
   */
  provider: string;
  /**
   * Claims a token must carry, as canonical attribute name → required
   * value (for GitHub Actions: `repository`, `ref`, `environment`, …). At
   * least one pin is required. Changing it replaces the binding.
   */
  attributeFilter: Record<string, string>;
};

export type OidcBinding = Resource<
  "Entire.OidcBinding",
  OidcBindingProps,
  {
    /** Binding ID. */
    id: string;
    accountId: string;
    /** Provider ID (`wip_…`) of the trusted issuer. */
    providerId: string;
    attributeFilter: Record<string, string>;
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * Lets workloads sign in as a {@link ServiceAccount}: an OIDC token from the
 * trusted issuer whose claims match `attributeFilter` can be exchanged for
 * an Entire session (the `entire:sa-session` scope). Entire trusts a fixed
 * list of issuers; `Entire.identity.listOIDCProviders` returns it.
 *
 * Bindings are immutable, so any change replaces the binding.
 *
 * ### Trusting CI
 * **Example:** GitHub Actions on the main branch of one repository
 * ```typescript
 * yield* Entire.OidcBinding("ci-github", {
 *   accountId: ci.accountId,
 *   provider: "github-actions",
 *   attributeFilter: { repository: "acme/api", ref: "refs/heads/main" },
 * });
 * ```
 *
 * @resource
 * @product ServiceAccount
 */
export const OidcBinding = Resource<OidcBinding>("Entire.OidcBinding");

/** No trusted OIDC issuer matches `provider`. */
export class OidcProviderNotFound extends Data.TaggedError("OidcProviderNotFound")<{
  readonly provider: string;
  readonly message: string;
}> {}

const toAttrs = (b: Entire.serviceAccounts.Binding) => ({
  id: b.id,
  accountId: b.accountId,
  providerId: b.providerId,
  attributeFilter: (b.attributeFilter ?? {}) as Record<string, string>,
  createdAt: b.createdAt,
});

const sameFilter = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export const OidcBindingProvider = () =>
  Provider.effect(
    OidcBinding,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const resolveProvider = Effect.fn(function* (provider: string) {
        const { providers } = yield* client.core(Entire.identity.listOIDCProviders({}));
        const match = providers.find((p) => p.id === provider || p.displayName === provider);
        if (!match) {
          return yield* new OidcProviderNotFound({
            provider,
            message: `no trusted OIDC issuer named "${provider}"; known: ${providers.map((p) => p.displayName).join(", ")}`,
          });
        }
        return match.id;
      });

      const find = (accountId: string, predicate: (b: Entire.serviceAccounts.Binding) => boolean) =>
        client.core(
          Entire.serviceAccounts.listBindings
            .items({ accountId })
            .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrUndefined)),
        );

      return {
        stables: ["id", "accountId", "providerId", "createdAt"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || !olds) return undefined;
          if (
            news.accountId !== olds.accountId ||
            news.provider !== olds.provider ||
            !sameFilter(news.attributeFilter, olds.attributeFilter)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const binding = yield* find(output.accountId, (b) => b.id === output.id).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          return binding ? toAttrs(binding) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const providerId = yield* resolveProvider(news.provider);
          // Observe: the cached binding, else an identical one (a retried
          // create that landed before state was saved).
          const observed = yield* find(news.accountId, (b) =>
            output?.id
              ? b.id === output.id
              : b.providerId === providerId &&
                sameFilter(
                  (b.attributeFilter ?? {}) as Record<string, string>,
                  news.attributeFilter,
                ),
          );
          if (observed) return toAttrs(observed);
          return toAttrs(
            yield* client.core(
              Entire.serviceAccounts.createBinding({
                accountId: news.accountId,
                providerId,
                attributeFilter: news.attributeFilter,
              }),
            ),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(
              Entire.serviceAccounts.deleteBinding({
                accountId: output.accountId,
                bindingId: output.id,
              }),
            )
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
