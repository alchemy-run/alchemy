import * as dremio from "@distilled.cloud/stackit/dremio";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope, type ProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers, secretsDiffer } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findInstanceByName,
  generatedDisplayName,
  getInstanceOrUndefined,
  listOwnedInstances,
  requestScope,
  settleInstance,
  waitForInstance,
  waitForInstanceGone,
} from "./internal.ts";

/** Sign in with Microsoft Entra ID (Azure Active Directory). */
export interface InstanceAzureAdAuthentication {
  /** The Azure AD authority URL. */
  authorityUrl: string;
  /** The Azure AD client id. */
  clientId: string;
  /** The Azure AD client secret. STACKIT never returns it. */
  clientSecret: string | Redacted.Redacted<string>;
}

/** One more parameter the identity provider requires. */
export interface InstanceOAuthParameter {
  /** Name of the parameter. */
  name: string;
  /** Value of the parameter. */
  value: string;
}

/** Sign in with an OpenID Connect identity provider. */
export interface InstanceOAuthAuthentication {
  /** The issuer URI, where the provider's OpenID configuration can be found. */
  authorityUrl: string;
  /** The client id the identity provider assigned. */
  clientId: string;
  /** The client secret the identity provider generated. STACKIT never returns it. */
  clientSecret: string | Redacted.Redacted<string>;
  /** Maps fields of the JWT to what Dremio requires. */
  jwtClaims: {
    /** The claim holding the user's name, e.g. `email`. */
    userName: string;
  };
  /** More parameters the identity provider requires. */
  parameters?: InstanceOAuthParameter[];
  /**
   * Space-separated scopes. `openid` is always required.
   *
   * @default "openid profile"
   */
  scope?: string;
}

/** How users sign in to the instance. */
export type InstanceAuthentication =
  | {
      /** Only users created on the instance, such as `Stackit.Dremio.User`. */
      type: "local-only";
    }
  | {
      /** Microsoft Entra ID. */
      type: "azuread";
      /** The Entra ID application. */
      azuread: InstanceAzureAdAuthentication;
    }
  | {
      /** An OpenID Connect provider. */
      type: "oauth";
      /** The provider's client. */
      oauth: InstanceOAuthAuthentication;
    };

export interface InstanceProps {
  /**
   * Display name, up to 32 letters, digits and spaces. Updates in place. Replacing an
   * instance with an explicit name deletes the old one first.
   *
   * @default a unique name generated from the stack, stage and logical ID, with spaces for hyphens
   */
  displayName?: string;
  /** Longer description, up to 1024 characters. Updates in place; omit it to leave the live one alone. */
  description?: string;
  /**
   * IPv4 and IPv6 CIDR ranges allowed to connect. An empty list allows any address, and so
   * does omitting it from a new instance. Updates in place and replaces the whole list;
   * omit it to leave the live list alone.
   */
  acl?: string[];
  /**
   * How users sign in. Changing it updates in place, but **restarts Dremio, with downtime**.
   * A new instance without it is `local-only`; omit it from a deployed one to leave the live
   * setting alone.
   *
   * @default { type: "local-only" }
   */
  authentication?: InstanceAuthentication;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

/** The URLs an instance serves. */
export interface InstanceEndpoints {
  /** The URL of the console. */
  ui: string;
  /** The catalog endpoint. */
  catalog: string;
  /** The Arrow Flight endpoint. */
  arrowFlight: string;
}

/** How users sign in, as STACKIT reports it: never with a client secret. */
export interface InstanceAuthenticationAttributes {
  /** `local-only`, `azuread` or `oauth`. */
  type: string;
  /** The Entra ID application, for `azuread`. */
  azuread?: {
    /** The Azure AD authority URL. */
    authorityUrl: string;
    /** The Azure AD client id. */
    clientId: string;
  };
  /** The provider's client, for `oauth`. */
  oauth?: {
    /** The issuer URI. */
    authorityUrl: string;
    /** The client id. */
    clientId: string;
    /** The claim holding the user's name. */
    userNameClaim: string;
    /** More parameters the identity provider requires. */
    parameters?: InstanceOAuthParameter[];
    /** Space-separated scopes. */
    scope?: string;
  };
}

export interface InstanceAttributes {
  /** STACKIT instance id. Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Display name. */
  displayName: string;
  /** Description. */
  description: string | undefined;
  /** CIDR ranges allowed to connect. An empty list allows any address. */
  acl: string[];
  /** How users sign in. */
  authentication: InstanceAuthenticationAttributes;
  /** The redirect URL to register with the identity provider, for `azuread` and `oauth`. */
  redirectUrl: string | undefined;
  /** The URLs the instance serves. */
  endpoints: InstanceEndpoints;
  /** Instance state; `active` after a deploy. */
  state: string;
  /** What to fix, when the instance reports an error the user can resolve. */
  errorMessage: string | undefined;
  /** When the instance was created. */
  createTime: string;
}

export type Instance = Resource<
  "Stackit.Dremio.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Dremio instance: a managed Dremio lakehouse engine that queries data where it
 * lies, with Iceberg tables and other sources.
 *
 * Display name, description, `acl` and `authentication` update in place, but changing
 * `authentication` restarts Dremio, with downtime. Moving the instance to another project or
 * region replaces it, and **replacing an instance loses what lives on it** (spaces, views,
 * users, and job history); data in your own sources stays. STACKIT leaves backups to you.
 *
 * The API has no labels. Alchemy tells its own instance by the id in state, or by a generated
 * name, so an instance found by an explicit name without state is reported as unowned, and
 * only taken over with `--adopt`. `alchemy unsafe nuke` deletes every instance whose display
 * name has the shape of a generated one: choose another shape for an instance that must
 * survive a nuke.
 *
 * See [STACKIT's Dremio docs](https://docs.stackit.cloud/products/data-and-ai/dremio/).
 *
 * :::caution[STACKIT Dremio is a beta API]
 * STACKIT serves this API as `v1beta`, and its Terraform resource is marked experimental, so
 * it may change. Terraform documents it as available in `eu01` only.
 * :::
 *
 * :::caution[Changing `projectId` or `region` replaces the Instance]
 * Replacing an instance loses what lives on it: spaces, views, users and job history.
 * Data in your own sources stays.
 * :::
 *
 * ### Creating an Instance
 * **Example:** An instance with local users
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lakehouse = yield* Stackit.Dremio.Instance("Lakehouse", {
 *   displayName: "Analytics",
 *   description: "Sales lakehouse",
 * });
 * // lakehouse.endpoints.ui is the console
 * ```
 *
 * ### Restricting Access
 * **Example:** Allow only your office network
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lakehouse = yield* Stackit.Dremio.Instance("Lakehouse", {
 *   acl: ["203.0.113.0/24", "2001:db8::/32"],
 * });
 * ```
 *
 * ### Signing In with an Identity Provider
 * **Example:** OpenID Connect
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const lakehouse = yield* Stackit.Dremio.Instance("Lakehouse", {
 *   authentication: {
 *     type: "oauth",
 *     oauth: {
 *       authorityUrl: "https://login.example.com/realms/acme",
 *       clientId: "dremio",
 *       clientSecret: Config.Redacted("DREMIO_OIDC_CLIENT_SECRET"),
 *       jwtClaims: { userName: "email" },
 *       scope: "openid profile email",
 *     },
 *   },
 * });
 * // Register lakehouse.redirectUrl with the identity provider.
 * ```
 *
 * **Example:** Microsoft Entra ID
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const lakehouse = yield* Stackit.Dremio.Instance("Lakehouse", {
 *   authentication: {
 *     type: "azuread",
 *     azuread: {
 *       authorityUrl: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000",
 *       clientId: "11111111-1111-1111-1111-111111111111",
 *       clientSecret: Config.Redacted("DREMIO_ENTRA_CLIENT_SECRET"),
 *     },
 *   },
 * });
 * ```
 *
 * ### Running SQL from a Runtime
 * **Example:** Submit a statement from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Lakehouse = Stackit.Dremio.Instance("Lakehouse", {});
 * export const Analyst = Effect.gen(function* () {
 *   const lakehouse = yield* Lakehouse;
 *   const password = yield* Alchemy.Random("AnalystPassword");
 *   return yield* Stackit.Dremio.User("Analyst", {
 *     instanceId: lakehouse.instanceId,
 *     email: "analyst@example.com",
 *     firstName: "Ada",
 *     lastName: "Analyst",
 *     password: password.text,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const analyst = yield* Analyst;
 *     const executeSql = yield* Stackit.Dremio.ExecuteSql(analyst);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const job = yield* executeSql({ sql: "SELECT 1" });
 *         return yield* HttpServerResponse.json({ jobId: job.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Dremio.ExecuteSqlHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Dremio
 * @category Dremio
 */
export const Instance = Resource<Instance>("Stackit.Dremio.Instance");

const LOCAL_ONLY: InstanceAuthentication = { type: "local-only" };

/** The spec's default for `oauth.scope`, which the API fills in when it's omitted. */
const DEFAULT_OAUTH_SCOPE = "openid profile";

const byName = (a: InstanceOAuthParameter, b: InstanceOAuthParameter) =>
  a.name.localeCompare(b.name);

const toAuthenticationAttributes = (
  observed: dremio.AuthenticationOutput,
): InstanceAuthenticationAttributes => ({
  type: observed.type,
  ...(observed.azuread === undefined
    ? {}
    : {
        azuread: {
          authorityUrl: observed.azuread.authorityUrl,
          clientId: observed.azuread.clientId,
        },
      }),
  ...(observed.oauth === undefined
    ? {}
    : {
        oauth: {
          authorityUrl: observed.oauth.authorityUrl,
          clientId: observed.oauth.clientId,
          userNameClaim: observed.oauth.jwtClaims.userName,
          ...(observed.oauth.parameters === undefined
            ? {}
            : {
                parameters: observed.oauth.parameters.map(({ name, value }) => ({ name, value })),
              }),
          ...(observed.oauth.scope === undefined ? {} : { scope: observed.oauth.scope }),
        },
      }),
});

const toAttrs = (
  scope: ProjectScope,
  instance: dremio.DremioResponseOutput,
): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: instance.displayName,
  description: instance.description,
  acl: [...instance.acl],
  authentication: toAuthenticationAttributes(instance.authentication),
  redirectUrl:
    instance.authentication.oauth?.redirectUrl ?? instance.authentication.azuread?.redirectUrl,
  endpoints: {
    ui: instance.endpoints.ui,
    catalog: instance.endpoints.catalog,
    arrowFlight: instance.endpoints.arrowFlight,
  },
  state: instance.state,
  errorMessage: instance.errorMessage,
  createTime: instance.create_time,
});

/** The parts of the live authentication settings a prop can set, comparable as text. */
const observedAuthenticationKey = (observed: dremio.AuthenticationOutput): string =>
  JSON.stringify({
    type: observed.type,
    azuread:
      observed.type === "azuread" && observed.azuread !== undefined
        ? [observed.azuread.authorityUrl, observed.azuread.clientId]
        : undefined,
    oauth:
      observed.type === "oauth" && observed.oauth !== undefined
        ? [
            observed.oauth.authorityUrl,
            observed.oauth.clientId,
            observed.oauth.jwtClaims.userName,
            [...(observed.oauth.parameters ?? [])].sort(byName).map((p) => [p.name, p.value]),
            observed.oauth.scope ?? DEFAULT_OAUTH_SCOPE,
          ]
        : undefined,
  });

/** {@link observedAuthenticationKey} for a prop. The secret can't be observed, so it's left out. */
const desiredAuthenticationKey = (desired: InstanceAuthentication): string =>
  JSON.stringify({
    type: desired.type,
    azuread:
      desired.type === "azuread"
        ? [desired.azuread.authorityUrl, desired.azuread.clientId]
        : undefined,
    oauth:
      desired.type === "oauth"
        ? [
            desired.oauth.authorityUrl,
            desired.oauth.clientId,
            desired.oauth.jwtClaims.userName,
            [...(desired.oauth.parameters ?? [])].sort(byName).map((p) => [p.name, p.value]),
            desired.oauth.scope ?? DEFAULT_OAUTH_SCOPE,
          ]
        : undefined,
  });

const clientSecretOf = (authentication: InstanceAuthentication | undefined) =>
  authentication?.type === "azuread"
    ? authentication.azuread.clientSecret
    : authentication?.type === "oauth"
      ? authentication.oauth.clientSecret
      : undefined;

/** What the API takes: `redirectUrl` is read-only, and a type carries only its own block. */
const toAuthenticationInput = (desired: InstanceAuthentication): dremio.AuthenticationInput =>
  desired.type === "azuread"
    ? { type: "azuread", azuread: { ...desired.azuread } }
    : desired.type === "oauth"
      ? {
          type: "oauth",
          oauth: {
            authorityUrl: desired.oauth.authorityUrl,
            clientId: desired.oauth.clientId,
            clientSecret: desired.oauth.clientSecret,
            jwtClaims: { userName: desired.oauth.jwtClaims.userName },
            ...(desired.oauth.parameters === undefined
              ? {}
              : { parameters: desired.oauth.parameters.map((p) => ({ ...p })) }),
            ...(desired.oauth.scope === undefined ? {} : { scope: desired.oauth.scope }),
          },
        }
      : { type: "local-only" };

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "createTime"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listOwnedInstances(scope);
      return instances.map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Nothing but a name holds the replacement back, and only an explicit one: a
      // generated name carries the generation, so it can't collide.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A `Redacted` serializes to a fixed marker, so the engine's default comparison
      // can't see a new client secret, and the API never returns the old one.
      if (
        isResolved(news) &&
        olds !== undefined &&
        secretsDiffer(clientSecretOf(news.authentication), clientSecretOf(olds.authentication))
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.instanceId !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId);
      }
      const generated = yield* generatedDisplayName(id);
      const name = output?.displayName ?? olds?.displayName ?? generated;
      const found = yield* findInstanceByName(scope, name);
      if (found === undefined || found.state === "deleting") return undefined;
      const attrs = toAttrs(scope, found);
      // No labels: a generated name holds this generation's id, so it is ours. An explicit
      // name proves nothing, unless it is the generation being replaced. An id is unique, but
      // the scope has to match too, as it does for every other resource here.
      const isPrevious =
        previous?.instanceId === found.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return name === generated || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedDisplayName(id);
      const displayName = news.displayName ?? output?.displayName ?? generated;

      // 1. Observe — `output` is a cache for the id, and only names the desired instance
      // while it sits in the same project and region. Without it, only this generation's
      // generated name can be claimed.
      let current: dremio.DremioResponseOutput | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getInstanceOrUndefined(scope, output.instanceId);
      }
      if (current === undefined && displayName === generated) {
        current = yield* findInstanceByName(scope, displayName);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForInstanceGone(scope, current.id);
        current = undefined;
      }

      // 2. Ensure
      let created = false;
      if (current === undefined) {
        current = yield* dremio
          .createDremioInstance({
            ...requestScope(scope),
            displayName,
            ...(news.description === undefined ? {} : { description: news.description }),
            ...(news.acl === undefined ? {} : { acl: [...news.acl] }),
            authentication: toAuthenticationInput(news.authentication ?? LOCAL_ONLY),
          })
          .pipe(
            // Lost a race against our own create: observe it. Anything else holding
            // the name is not ours, and still fails.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found =
                  displayName === generated
                    ? yield* findInstanceByName(scope, displayName)
                    : undefined;
                return found ?? (yield* Effect.fail(error));
              }),
            ),
          );
        created = true;
      }
      const liveId = current.id;
      // An update can repair an instance in `error`, so settling only waits out a change
      // in flight, and the wait below decides.
      current = yield* settleInstance(scope, liveId).pipe(
        // A read straight after the create can miss the new instance.
        Effect.retry({
          while: (error) => created && error._tag === "NotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 6,
        }),
      );

      // 3. Sync — observed values against the desired ones. Sending `authentication`
      // restarts Dremio, so it only goes out when a value differs. The client secret can't
      // be observed: it's compared with what was last deployed, and sent when there's no
      // telling, on an adoption.
      const clientSecret = clientSecretOf(news.authentication);
      const secretChanged =
        !created &&
        clientSecret !== undefined &&
        (olds === undefined || secretsDiffer(clientSecret, clientSecretOf(olds.authentication)));
      const authenticationChanged =
        news.authentication !== undefined &&
        (secretChanged ||
          observedAuthenticationKey(current.authentication) !==
            desiredAuthenticationKey(news.authentication));
      const delta = {
        ...(current.displayName === displayName ? {} : { displayName }),
        ...(news.description === undefined || (current.description ?? "") === news.description
          ? {}
          : { description: news.description }),
        ...(news.acl === undefined || sameMembers(current.acl, news.acl)
          ? {}
          : { acl: [...news.acl] }),
        ...(authenticationChanged && news.authentication !== undefined
          ? { authentication: toAuthenticationInput(news.authentication) }
          : {}),
      };
      const repairing = current.state === "error";
      if (Object.keys(delta).length > 0) {
        yield* dremio
          .updateDremioInstance({ ...requestScope(scope), dremioId: liveId, ...delta })
          .pipe(Effect.retry(conflictRetry));
      }

      // 4. Return — an `error` from before the update above isn't the update's own, but
      // with no update it stands, and fails the deploy with the API's message.
      current = yield* waitForInstance(scope, liveId, {
        staleError: repairing && Object.keys(delta).length > 0,
      });
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const live = yield* getInstanceOrUndefined(scope, output.instanceId);
      if (live === undefined) return;
      if (live.state === "deleting") return yield* waitForInstanceGone(scope, live.id);
      // A change in flight (an interrupted deploy) settles first.
      const settled = yield* settleInstance(scope, live.id).pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (settled === undefined) return;
      yield* dremio.deleteDremioInstance({ ...requestScope(scope), dremioId: live.id }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitForInstanceGone(scope, live.id, { staleError: settled.state === "error" });
    }),
  });
