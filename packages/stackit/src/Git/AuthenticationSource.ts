import * as git from "@distilled.cloud/stackit/git";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  CHILD_TIMEOUT,
  getAuthenticationOrUndefined,
  type InstanceScope,
  retryWhileInTransition,
} from "./internal.ts";

export interface AuthenticationSourceProps {
  /** Id of the instance the source signs users in to. Changing it replaces the source. */
  instanceId: string;
  /** Name of the source on the instance. The API can't change it, so changing it replaces the source. */
  name: string;
  /** The identity provider's well-known configuration URL. Updates in place. */
  autoDiscoverUrl: string;
  /** The OAuth2 client's id at the identity provider. Updates in place. */
  clientId: string;
  /**
   * The OAuth2 client's secret. Updates in place when it changes. The API never returns it, so a
   * secret changed by hand isn't noticed.
   *
   * Alchemy records the props of every resource in its state store, and a `Redacted` value is
   * written there unencrypted, under a `__redacted__` marker.
   */
  clientSecret: string | Redacted.Redacted<string>;
  /** URL of the icon on the sign-in button. Omit to leave the live value alone. */
  iconUrl?: string;
  /** The OAuth2 provider. Omit to leave the live value alone. @default "openidConnect" */
  provider?: string;
  /** The OIDC scopes to request. Omit to leave the live value alone. @default "openid profile email" */
  scopes?: string;
  /** Project of the instance. Changing it replaces the source. @default the profile's project */
  projectId?: string;
}

export interface AuthenticationSourceAttributes {
  /** STACKIT id of the source. Stable across updates. */
  authenticationId: string;
  /** Id of the instance the source signs users in to. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** Name of the source on the instance. */
  name: string;
  /** The identity provider's well-known configuration URL. */
  autoDiscoverUrl: string;
  /** The OAuth2 client's id. */
  clientId: string;
  /** URL of the icon on the sign-in button. */
  iconUrl: string;
  /** The OAuth2 provider. */
  provider: string;
  /** The OIDC scopes requested. */
  scopes: string;
  /** `Ready` after a deploy. */
  status: git.AuthenticationStatus;
  /** When the source's creation was triggered. */
  createdAt: string;
}

export type AuthenticationSource = Resource<
  "Stackit.Git.AuthenticationSource",
  AuthenticationSourceProps,
  AuthenticationSourceAttributes,
  never,
  Providers
>;

/**
 * An OpenID Connect sign-in on a STACKIT Git instance, so users sign in with your own identity
 * provider.
 *
 * The name is its identity on the instance: changing it replaces the source. The other settings
 * update in place, and a deploy waits until the source reports `Ready`.
 *
 * The API has no labels here, so a source found by name with no state is reported as unowned and
 * only taken over with `--adopt`. Adopting a source sets its client secret to the one you give.
 * Sources go with their instance, so there is no `list`.
 *
 * See [STACKIT's Git docs](https://docs.stackit.cloud/products/developer-platform/git/).
 *
 * :::caution[Changing `instanceId`, `name` or `projectId` replaces the Source]
 * The name is the source's identity on the instance. The new source is created and the
 * old one is deleted.
 * :::
 *
 * ### Creating a Source
 * **Example:** Sign in with your identity provider
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const clientSecret = Config.Redacted("FORGE_OIDC_CLIENT_SECRET");
 * const sso = yield* Stackit.Git.AuthenticationSource("Sso", {
 *   instanceId: forge.instanceId,
 *   name: "company-sso",
 *   autoDiscoverUrl: "https://id.example.com/.well-known/openid-configuration",
 *   clientId: "forge",
 *   clientSecret,
 * });
 * ```
 *
 * ### Configuring the Source
 * **Example:** A button icon and narrower scopes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * const clientSecret = Config.Redacted("FORGE_OIDC_CLIENT_SECRET");
 * const sso = yield* Stackit.Git.AuthenticationSource("Sso", {
 *   instanceId: forge.instanceId,
 *   name: "company-sso",
 *   autoDiscoverUrl: "https://id.example.com/.well-known/openid-configuration",
 *   clientId: "forge",
 *   clientSecret,
 *   iconUrl: "https://id.example.com/icon.png",
 *   scopes: "openid email",
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new name is a new source
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * // Creates company-login, then deletes company-sso.
 * const sso = yield* Stackit.Git.AuthenticationSource("Sso", {
 *   instanceId: forge.instanceId,
 *   name: "company-login",
 *   autoDiscoverUrl: "https://id.example.com/.well-known/openid-configuration",
 *   clientId: "forge",
 *   clientSecret: Redacted.make("not-a-real-secret"),
 * });
 * ```
 *
 * @resource
 * @product STACKIT Git
 * @category Git
 */
export const AuthenticationSource = Resource<AuthenticationSource>(
  "Stackit.Git.AuthenticationSource",
);

const toAttrs = (
  scope: InstanceScope,
  source: git.Authentication,
): AuthenticationSourceAttributes => ({
  authenticationId: source.id,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
  name: source.name,
  autoDiscoverUrl: source.auto_discover_url,
  clientId: source.client_id,
  iconUrl: source.icon_url,
  provider: source.provider,
  scopes: source.scopes,
  status: source.status,
  createdAt: source.created_at,
});

const findByName = (scope: InstanceScope, name: string) =>
  git
    .listAuthentication({ ...scope })
    .pipe(
      Effect.map(({ authentication }) => authentication.find((source) => source.name === name)),
    );

const waitForGone = (scope: InstanceScope, authenticationId: string) =>
  waitUntilGone({
    resource: `authentication source ${authenticationId}`,
    read: getAuthenticationOrUndefined(scope, authenticationId),
    failed: (source) =>
      source.status === "Error" ? (source.status_message ?? source.status) : undefined,
    state: (source) => source.status,
    timeout: CHILD_TIMEOUT,
  });

/** What a PATCH has to send, diffed against the observed source. A secret can't be observed. */
const sourceDelta = (source: git.Authentication, news: AuthenticationSourceProps) => ({
  ...(source.auto_discover_url !== news.autoDiscoverUrl
    ? { auto_discover_url: news.autoDiscoverUrl }
    : {}),
  ...(source.client_id !== news.clientId ? { client_id: news.clientId } : {}),
  ...(news.iconUrl !== undefined && source.icon_url !== news.iconUrl
    ? { icon_url: news.iconUrl }
    : {}),
  ...(news.provider !== undefined && source.provider !== news.provider
    ? { provider: news.provider }
    : {}),
  ...(news.scopes !== undefined && source.scopes !== news.scopes ? { scopes: news.scopes } : {}),
});

export const AuthenticationSourceProvider = () =>
  Provider.succeed(AuthenticationSource, {
    stables: ["authenticationId", "instanceId", "projectId", "name", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A name can't exist twice on an instance, and an unresolved value can resolve to the scope
      // and name the source already has: delete the old source first.
      if (
        hasUnresolvedTrigger<AuthenticationSourceProps>(news, ["instanceId", "projectId", "name"])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<AuthenticationSourceProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        resolved.name !== (olds?.name ?? output.name)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A `Redacted` serializes to a fixed marker, so the engine's default comparison can't see a
      // new secret, and the API never returns the old one.
      const clientSecret = rawProp<AuthenticationSourceProps>(news, "clientSecret");
      if (
        isResolved(clientSecret) &&
        olds !== undefined &&
        secretsDiffer(clientSecret, olds.clientSecret)
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const scope = {
        projectId: output?.projectId ?? olds?.projectId ?? env.projectId,
        instanceId,
      };
      const byId =
        output?.authenticationId !== undefined
          ? yield* getAuthenticationOrUndefined(scope, output.authenticationId)
          : undefined;
      const name = output?.name ?? olds?.name;
      const source = byId ?? (name !== undefined ? yield* findByName(scope, name) : undefined);
      if (source === undefined || source.status === "Deleting") return undefined;
      const attrs = toAttrs(scope, source);
      if (output?.authenticationId === source.id) return attrs;
      const isPrevious =
        previous?.authenticationId === source.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const scope = {
        projectId: news.projectId ?? output?.projectId ?? env.projectId,
        instanceId: news.instanceId,
      };
      const resource = `authentication source ${news.name}`;

      // 1. Observe — `output` is a cache for the id, and only names the desired source while it
      // sits on the desired instance under the desired name.
      let current: git.Authentication | undefined =
        output?.instanceId === scope.instanceId &&
        output.projectId === scope.projectId &&
        output.name === news.name
          ? yield* getAuthenticationOrUndefined(scope, output.authenticationId)
          : undefined;
      current ??= yield* findByName(scope, news.name);
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.status === "Deleting") {
        yield* waitForGone(scope, current.id);
        current = undefined;
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      let createdNow = false;
      if (current === undefined) {
        current = yield* git
          .createAuthentication({
            ...scope,
            name: news.name,
            auto_discover_url: news.autoDiscoverUrl,
            client_id: news.clientId,
            client_secret: news.clientSecret,
            ...(news.iconUrl !== undefined ? { icon_url: news.iconUrl } : {}),
            ...(news.provider !== undefined ? { provider: news.provider } : {}),
            ...(news.scopes !== undefined ? { scopes: news.scopes } : {}),
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                createdNow = true;
              }),
            ),
            Effect.catchTag("Conflict", (error) =>
              findByName(scope, news.name).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }
      const authenticationId = current.id;

      const settle = (
        applied: (source: git.Authentication) => boolean,
        options: { readonly ignoreError?: boolean } = {},
      ) =>
        waitFor({
          resource,
          // A new source can take a moment to be readable.
          read: getAuthenticationOrUndefined(scope, authenticationId),
          ready: (source) => source?.status === "Ready" && applied(source),
          failed: (source) =>
            source?.status === "Error" && options.ignoreError !== true
              ? (source.status_message ?? source.status)
              : undefined,
          state: (source) => source?.status ?? "not visible yet",
          timeout: CHILD_TIMEOUT,
        });

      // 3. Sync — against the observed source. A source in `Error` is the one case to patch before
      // it settles: new settings are how it recovers, and the failure predates them.
      const failedBefore = current.status === "Error";
      const observed: git.Authentication = failedBefore
        ? current
        : ((yield* settle(() => true)) ?? current);
      const delta = {
        ...sourceDelta(observed, news),
        ...(!createdNow &&
        (olds === undefined || secretsDiffer(news.clientSecret, olds.clientSecret))
          ? { client_secret: news.clientSecret }
          : {}),
      };
      current = observed;
      if (Object.keys(delta).length > 0) {
        yield* git.patchAuthentication({ ...scope, authenticationId, ...delta });
        const synced = yield* settle(
          (source) => Object.keys(sourceDelta(source, news)).length === 0,
          { ignoreError: failedBefore },
        );
        current = synced ?? current;
      } else if (failedBefore) {
        current = (yield* settle(() => true)) ?? current;
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      const { authenticationId } = output;
      const current = yield* getAuthenticationOrUndefined(scope, authenticationId);
      if (current === undefined) return;
      if (current.status !== "Deleting") {
        yield* retryWhileInTransition(
          git.deleteAuthentication({ ...scope, authenticationId }),
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitForGone(scope, authenticationId);
    }),
  });
