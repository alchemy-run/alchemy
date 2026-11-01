import * as edge from "@distilled.cloud/stackit/edge";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor } from "../internal/wait.ts";

/** Service id the Edge Cloud API needs enabled per project. */
export const EDGE_SERVICE_ID = "cloud.stackit.edge-cloud";

/** Create, update, delete and credential budget, from the Go SDK's wait handlers. */
export const INSTANCE_TIMEOUT = "10 minutes";

export const POLL = { interval: "5 seconds", maxInterval: "15 seconds" } as const;

/** The project and region an instance lives in. */
export interface EdgeScope {
  readonly projectId: string;
  readonly region: string;
}

/**
 * A generated display name. The API takes 4 to 8 characters, too few for the stack,
 * stage and logical id, so the name is a fixed prefix and part of this generation's
 * instance id.
 */
export const generatedDisplayName = (id: string) =>
  createPhysicalName({ id, prefix: "a7-", suffixLength: 5, maxLength: 8, lowercase: true });

const GENERATED_DISPLAY_NAME = /^a7-[a-z2-7]{5}$/;

/** Whether a display name has the shape {@link generatedDisplayName} produces. */
export const isGeneratedDisplayName = (displayName: string): boolean =>
  GENERATED_DISPLAY_NAME.test(displayName);

/** `GetInstance`; `undefined` when the typed `NotFound` says it's missing. */
export const getInstanceOrUndefined = (scope: EdgeScope, instanceId: string) =>
  edge
    .getInstance({ projectId: scope.projectId, regionId: scope.region, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetInstanceByName`; `undefined` when the typed `NotFound` says it's missing. */
export const getInstanceByNameOrUndefined = (scope: EdgeScope, displayName: string) =>
  edge
    .getInstanceByName({ projectId: scope.projectId, regionId: scope.region, displayName })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Whether a live instance is the one `created` was recorded from. An instance's id
 * is `<displayName>-<project hash>`, so an instance deleted and created again under
 * the same name has the same id. Its creation time is what tells them apart.
 */
export const isSameInstance = (live: edge.Instance, created: string | undefined): boolean =>
  created === undefined ||
  live.created === created ||
  new Date(live.created).getTime() === new Date(created).getTime();

// ── Kubeconfig and Token: credentials minted by a GET, with no server-side object ──

/** The API's default credential lifetime, in seconds. */
export const DEFAULT_EXPIRATION_SECONDS = 3600;

/** What `Kubeconfig` and `Token` share of their props. */
export interface CredentialProps {
  instanceId: string;
  expirationSeconds?: number;
  refreshBeforeSeconds?: number;
  projectId?: string;
  region?: string;
}

/** What `Kubeconfig` and `Token` share of their attributes. */
export interface CredentialAttributes {
  instanceId: string;
  projectId: string;
  region: string;
  expirationSeconds: number;
  mintedAt: string;
  expiresAt: string;
  instanceCreated: string;
}

/** The re-mint window: the prop, or a tenth of the lifetime. */
export const refreshWindowOf = (refreshBeforeSeconds: number | undefined, ttl: number): number =>
  refreshBeforeSeconds ?? ttl / 10;

/**
 * Why a held credential can't be kept: it is expiring, or its instance is gone or
 * was recreated under the same id. `undefined` when it is still good.
 */
export const credentialStaleReason = Effect.fn(function* (
  output: CredentialAttributes,
  refreshBeforeSeconds: number,
) {
  const now = yield* Clock.currentTimeMillis;
  if (now >= new Date(output.expiresAt).getTime() - refreshBeforeSeconds * 1000) {
    return "expiring" as const;
  }
  const instance = yield* getInstanceOrUndefined(output, output.instanceId);
  if (instance === undefined || instance.status === "deleting") {
    return "instance-missing" as const;
  }
  return isSameInstance(instance, output.instanceCreated)
    ? undefined
    : ("instance-recreated" as const);
});

/**
 * The `diff` of a credential. The engine only calls `read` to recover or adopt, so
 * expiry is decided here: this is what every plan runs. Nothing physical is at
 * stake, so a replacement just mints a new one.
 */
export const diffCredential = Effect.fn(function* (
  news: unknown,
  output: CredentialAttributes | undefined,
) {
  if (output === undefined) return undefined;
  if (
    hasUnresolvedTrigger<CredentialProps>(news, [
      "instanceId",
      "expirationSeconds",
      "projectId",
      "region",
    ])
  ) {
    return { action: "replace" } as const;
  }
  const resolved = triggerProps<CredentialProps>(news);
  const scope = yield* resolveProjectScope(resolved, undefined);
  if (
    resolved.instanceId !== output.instanceId ||
    scope.projectId !== output.projectId ||
    scope.region !== output.region ||
    (resolved.expirationSeconds ?? DEFAULT_EXPIRATION_SECONDS) !== output.expirationSeconds
  ) {
    return { action: "replace" } as const;
  }
  if (!isResolved(news)) return undefined;
  const stale = yield* credentialStaleReason(
    output,
    refreshWindowOf(resolved.refreshBeforeSeconds, output.expirationSeconds),
  );
  return stale === undefined ? undefined : ({ action: "update" } as const);
});

const isUsable = (instance: edge.Instance) =>
  instance.status === "active" || instance.status === "reconciling";

/**
 * Mint a credential once the instance can serve it, as the Go SDK's kubeconfig and
 * token wait handlers do: the instance has to be `active` or `reconciling`, and a
 * 404 from the credential call means "not ready" until the budget runs out. A
 * missing instance fails with the typed `NotFound`.
 *
 * The API reports no expiry. It is counted from before the call, so it is never
 * later than the real one.
 */
export const mintWhenReady = <A, E, R>(options: {
  /** What is minted, for wait errors. */
  readonly resource: string;
  readonly scope: EdgeScope;
  readonly instanceId: string;
  readonly expirationSeconds: number;
  /** The credential call, with its `NotFound` mapped to `undefined`. */
  readonly mint: Effect.Effect<A | undefined, E, R>;
}) =>
  waitFor({
    resource: options.resource,
    read: Effect.gen(function* () {
      const instance = yield* edge.getInstance({
        projectId: options.scope.projectId,
        regionId: options.scope.region,
        instanceId: options.instanceId,
      });
      const now = yield* Clock.currentTimeMillis;
      const credential = isUsable(instance) ? yield* options.mint : undefined;
      return { instance, now, credential };
    }),
    ready: ({ credential }) => credential !== undefined,
    failed: ({ instance }) =>
      isUsable(instance) ? undefined : `the instance is ${instance.status}`,
    state: ({ instance }) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  }).pipe(
    Effect.map(({ instance, now, credential }) => ({
      // `ready` only passes a credential.
      credential: credential as A,
      mintedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + options.expirationSeconds * 1000).toISOString(),
      instanceCreated: instance.created,
    })),
  );

/**
 * A kubeconfig as text. The API returns it as a JSON object, in a `Redacted` by the
 * SDK's sensitive mark, and JSON is valid YAML, so this is a file `kubectl` reads.
 * The Terraform provider stores it the same way.
 */
export const kubeconfigText = (kubeconfig: unknown): Redacted.Redacted<string> => {
  const raw = Redacted.isRedacted(kubeconfig) ? Redacted.value(kubeconfig) : kubeconfig;
  return Redacted.make(typeof raw === "string" ? raw : JSON.stringify(raw));
};

/** A token, always `Redacted`. */
export const tokenValue = (token: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof token === "string" ? Redacted.make(token) : token;
