import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import { AdoptPolicy, OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { conflictRetry, emptyToUndefined, generatedDisplayName } from "../internal/displayNames.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredLabels,
  diffLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  managedLabels,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

/** Where a link takes audit logs from: one project, folder or organization. */
export type LinkScope =
  | {
      /** Id of the project. */
      projectId: string;
    }
  | {
      /** Id of the folder. */
      folderId: string;
    }
  | {
      /** Id of the organization. */
      organizationId: string;
    };

/** The kind of container a link takes audit logs from. */
export type LinkScopeType = "project" | "folder" | "organization";

export interface LinkProps {
  /**
   * The project, folder or organization whose audit logs the link sends. A folder or an
   * organization needs elevated rights. Changing it replaces the link.
   *
   * @default the profile's project
   */
  scope?: LinkScope;
  /**
   * Id of the `Stackit.Telemetry.Router` receiving the logs. It has to be in the same
   * region as the link. Updates in place.
   */
  routerId: string;
  /**
   * An access token of the router: a `Stackit.Telemetry.AccessToken`'s `accessToken` fits
   * as it is. Updates in place. That attribute is `undefined` only on a token taken over
   * with `--adopt`: a link can't be created from one, and an existing link keeps the
   * token it has.
   */
  accessToken: string | Redacted.Redacted<string> | undefined;
  /**
   * Name shown in the STACKIT portal: 1 to 32 characters, starting with a letter or a
   * digit, then letters, digits, hyphens and spaces. Updates in place.
   *
   * @default a name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * Description, at most 1024 characters of letters, digits, hyphens and spaces. Updates
   * in place; omit to leave the live value alone, or set `""` to clear it.
   */
  description?: string;
  /**
   * Whether audit logs flow through the link. Updates in place.
   *
   * @default true
   */
  enabled?: boolean;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Region of the link. Changing it replaces the link. @default the profile's region */
  region?: string;
}

export interface LinkAttributes {
  /** STACKIT link id (UUID). */
  linkId: string;
  /** The kind of container the link takes audit logs from. */
  scopeType: LinkScopeType;
  /** Id of that project, folder or organization. */
  scopeId: string;
  /** Region of the link. */
  region: string;
  /** Id of the router receiving the logs. */
  routerId: string;
  /** Name shown in the STACKIT portal. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** Whether audit logs flow through the link. */
  enabled: boolean;
  /** State of the link: `active` or `inactive` after a deploy. */
  status: telemetry.TelemetryLinkResponseStatus;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** When the link was created. */
  createTime: string;
}

export type Link = Resource<"Stackit.Telemetry.Link", LinkProps, LinkAttributes, never, Providers>;

/** A link can't be created without a token, and the one given has no known value. */
export class LinkAccessTokenMissing extends Data.TaggedError(
  "Stackit.Telemetry.LinkAccessTokenMissing",
)<{
  readonly resource: string;
  readonly message: string;
}> {}

/**
 * Sends the STACKIT audit logs of a project, folder or organization to a
 * `Stackit.Telemetry.Router`. Only STACKIT's audit logs travel this way: routers don't
 * take a customer's own logs, metrics or traces.
 *
 * A scope has one link per region, so `Link` is a singleton: `scope` and `region` are its
 * identity, and changing either replaces it. Everything else updates in place, including
 * the token, which STACKIT never hands back.
 *
 * A link already at the scope without Alchemy's labels is reported as unowned and only
 * taken over with `--adopt`. Destroying a link taken over that way deletes it; the
 * configuration it had before is not restored. A link someone else made after this one was
 * deleted out of band is never updated without `--adopt`, and never deleted.
 *
 * ### Sending Audit Logs
 * **Example:** Route a project's audit logs
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("Audit", {});
 * const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *   routerId: router.routerId,
 * });
 * yield* Stackit.Telemetry.Link("ProjectAudit", {
 *   routerId: router.routerId,
 *   accessToken: token.accessToken,
 * });
 * ```
 *
 * ### Choosing the Scope
 * **Example:** Route an organization's or a folder's audit logs
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("Audit", {});
 * const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *   routerId: router.routerId,
 * });
 * yield* Stackit.Telemetry.Link("OrganizationAudit", {
 *   scope: { organizationId: "00000000-0000-0000-0000-000000000000" },
 *   routerId: router.routerId,
 *   accessToken: token.accessToken,
 * });
 * yield* Stackit.Telemetry.Link("FolderAudit", {
 *   scope: { folderId: "11111111-1111-1111-1111-111111111111" },
 *   routerId: router.routerId,
 *   accessToken: token.accessToken,
 * });
 * ```
 *
 * ### Pausing a Link
 * **Example:** Stop the logs without deleting the link
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("Audit", {});
 * const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *   routerId: router.routerId,
 * });
 * yield* Stackit.Telemetry.Link("ProjectAudit", {
 *   routerId: router.routerId,
 *   accessToken: token.accessToken,
 *   enabled: false,
 *   displayName: "project-audit",
 *   description: "Paused during the migration",
 *   labels: { team: "security" },
 * });
 * ```
 *
 * ### Reading the Link at Runtime
 * **Example:** Read its status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Audit = Effect.gen(function* () {
 *   const router = yield* Stackit.Telemetry.Router("Audit", {});
 *   const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *     routerId: router.routerId,
 *   });
 *   return yield* Stackit.Telemetry.Link("ProjectAudit", {
 *     routerId: router.routerId,
 *     accessToken: token.accessToken,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getLink = yield* Stackit.Telemetry.GetProjectLink(yield* Audit);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const link = yield* getLink({});
 *         return yield* HttpServerResponse.json({ status: link.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Telemetry.GetProjectLinkHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a link to another scope
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("Audit", {});
 * const token = yield* Stackit.Telemetry.AccessToken("AuditToken", {
 *   routerId: router.routerId,
 * });
 * // The new scope's link is created first, then the old scope's is deleted, and the old
 * // scope stops sending audit logs. A link at the new scope that isn't Alchemy's stops
 * // the deploy unless you pass `--adopt`.
 * yield* Stackit.Telemetry.Link("ProjectAudit", {
 *   scope: { projectId: "22222222-2222-2222-2222-222222222222" },
 *   routerId: router.routerId,
 *   accessToken: token.accessToken,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export const Link = Resource<Link>("Stackit.Telemetry.Link");

/** Link create, update and delete budget (the Go SDK's wait handlers, 10 minutes). */
const LINK_TIMEOUT = "10 minutes";
const POLL = { interval: "2 seconds", maxInterval: "15 seconds" } as const;
/** Polls a `failed` status may be left over from before a repairing PATCH. */
const STALE_FAILED_POLLS = 6;

interface ResolvedScope {
  readonly type: LinkScopeType;
  readonly id: string;
}

const explicitScope = (scope: LinkScope): ResolvedScope => {
  if ("folderId" in scope) return { type: "folder", id: scope.folderId };
  if ("organizationId" in scope) return { type: "organization", id: scope.organizationId };
  return { type: "project", id: scope.projectId };
};

const resolveScope = Effect.fn(function* (scope: LinkScope | undefined) {
  if (scope !== undefined) return explicitScope(scope);
  const env = yield* StackitEnvironment.current;
  return explicitScope({ projectId: env.projectId });
});

type LinkBody = Omit<telemetry.CreateOrUpdateProjectTelemetryLinkRequest, "projectId" | "regionId">;
type LinkPatch = Omit<telemetry.PartialUpdateProjectTelemetryLinkRequest, "projectId" | "regionId">;

/** The operations on one link: the same API on three paths. */
interface LinkApi {
  readonly get: Effect.Effect<
    telemetry.TelemetryLinkResponse,
    telemetry.GetProjectTelemetryLinkError,
    telemetry.StackitOpContext
  >;
  readonly create: (
    body: LinkBody,
  ) => Effect.Effect<
    telemetry.TelemetryLinkResponse,
    telemetry.CreateOrUpdateProjectTelemetryLinkError,
    telemetry.StackitOpContext
  >;
  readonly patch: (
    body: LinkPatch,
  ) => Effect.Effect<
    telemetry.TelemetryLinkResponse,
    telemetry.PartialUpdateProjectTelemetryLinkError,
    telemetry.StackitOpContext
  >;
  readonly remove: Effect.Effect<
    unknown,
    telemetry.DeleteProjectTelemetryLinkError,
    telemetry.StackitOpContext
  >;
}

const linkApi = (scope: ResolvedScope, regionId: string): LinkApi => {
  switch (scope.type) {
    case "project": {
      const on = { projectId: scope.id, regionId };
      return {
        get: telemetry.getProjectTelemetryLink(on),
        create: (body) => telemetry.createOrUpdateProjectTelemetryLink({ ...on, ...body }),
        patch: (body) => telemetry.partialUpdateProjectTelemetryLink({ ...on, ...body }),
        remove: telemetry.deleteProjectTelemetryLink(on),
      };
    }
    case "folder": {
      const on = { folderId: scope.id, regionId };
      return {
        get: telemetry.getFolderTelemetryLink(on),
        create: (body) => telemetry.createOrUpdateFolderTelemetryLink({ ...on, ...body }),
        patch: (body) => telemetry.partialUpdateFolderTelemetryLink({ ...on, ...body }),
        remove: telemetry.deleteFolderTelemetryLink(on),
      };
    }
    case "organization": {
      const on = { organizationId: scope.id, regionId };
      return {
        get: telemetry.getOrganizationTelemetryLink(on),
        create: (body) => telemetry.createOrUpdateOrganizationTelemetryLink({ ...on, ...body }),
        patch: (body) => telemetry.partialUpdateOrganizationTelemetryLink({ ...on, ...body }),
        remove: telemetry.deleteOrganizationTelemetryLink(on),
      };
    }
  }
};

const observe = (api: LinkApi) => api.get.pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Whether a link at the scope is the one a state row names, or carries this logical id's
 * labels. A link is addressed by its scope, so the API's answer alone says nothing about
 * whose it is: ours may have gone, and someone else's taken the scope.
 */
const isOurLink = (
  id: string,
  link: telemetry.TelemetryLinkResponse,
  output: LinkAttributes | undefined,
) =>
  Effect.gen(function* () {
    if (output?.linkId === link.id) return true;
    return yield* hasAlchemyLabels(id, link.resourceLabels);
  });

/** Whether this deploy was told to take over what it finds: the same order the engine uses. */
const adoptAllowed = (fqn: string) =>
  Effect.gen(function* () {
    const stack = yield* Effect.serviceOption(Stack);
    const onResource = Option.isSome(stack) ? stack.value.resources[fqn]?.Adopt : undefined;
    if (onResource !== undefined) return onResource;
    const policy = yield* Effect.serviceOption(AdoptPolicy);
    if (Option.isSome(policy)) return policy.value;
    const context = yield* Effect.serviceOption(AlchemyContext);
    return Option.isSome(context) && context.value.adopt === true;
  });

const toAttrs = (
  scope: ResolvedScope,
  region: string,
  link: telemetry.TelemetryLinkResponse,
): LinkAttributes => ({
  linkId: link.id,
  scopeType: scope.type,
  scopeId: scope.id,
  region,
  routerId: link.telemetryRouterId,
  displayName: link.displayName,
  description: emptyToUndefined(link.description),
  enabled: link.enabled,
  status: link.status,
  labels: stripInternalLabels(managedLabels(link.resourceLabels)),
  createTime: link.createTime,
});

/** What the link should hold. An omitted `description` is left alone. */
interface DesiredLink {
  readonly routerId: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly enabled: boolean;
  readonly labels: Record<string, string>;
}

/** The delta between an observed link and the desired state, without the token. */
const linkDelta = (link: telemetry.TelemetryLinkResponse, desired: DesiredLink): LinkPatch => {
  const { upsert, removed } = diffLabels(managedLabels(link.resourceLabels), desired.labels);
  return {
    ...(link.telemetryRouterId !== desired.routerId ? { telemetryRouterId: desired.routerId } : {}),
    ...(link.displayName !== desired.displayName ? { displayName: desired.displayName } : {}),
    ...(desired.description !== undefined && (link.description ?? "") !== desired.description
      ? { description: desired.description }
      : {}),
    ...(link.enabled !== desired.enabled ? { enabled: desired.enabled } : {}),
    // Values are nullable on PATCH: `null` removes a label.
    ...(upsert.length > 0 || removed.length > 0
      ? {
          resourceLabels: {
            ...desired.labels,
            ...Object.fromEntries(removed.map((key) => [key, null])),
          },
        }
      : {}),
  };
};

const applied = (link: telemetry.TelemetryLinkResponse, desired: DesiredLink): boolean => {
  const observed = managedLabels(link.resourceLabels);
  return (
    link.telemetryRouterId === desired.routerId &&
    link.displayName === desired.displayName &&
    (desired.description === undefined || (link.description ?? "") === desired.description) &&
    link.enabled === desired.enabled &&
    // Label removals aren't awaited: whether `null` removes one is unverified, and that
    // must not stall a deploy.
    Object.entries(desired.labels).every(([key, value]) => observed[key] === value)
  );
};

export const LinkProvider = () =>
  Provider.succeed(Link, {
    stables: ["linkId", "scopeType", "scopeId", "region"],
    // Nuke ordering: links go before routers, which refuse a delete while one points at them.
    nuke: { dependsOn: ["Stackit.Telemetry.Router"] },

    // A link is reached by its scope, not enumerable across an organization, so this
    // only sees the profile's project.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope: ResolvedScope = { type: "project", id: env.projectId };
      const link = yield* observe(linkApi(scope, env.region));
      return link !== undefined && isAlchemyOwned(link.resourceLabels)
        ? [toAttrs(scope, env.region, link)]
        : [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A scope holds one link per region, and an unresolved scope can resolve to the one
      // this link sits in: delete the old link first.
      if (hasUnresolvedTrigger<LinkProps>(news, ["scope", "region"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<LinkProps>(news);
      const env = yield* StackitEnvironment.current;
      const scope = yield* resolveScope(resolved.scope);
      // A different scope or region is a different singleton, which can exist alongside.
      if (
        scope.type !== output.scopeType ||
        scope.id !== output.scopeId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A `Redacted` serializes to a fixed marker, so the engine's default misses a new
      // token.
      const token = rawProp<LinkProps>(news, "accessToken");
      if (isResolved(token) && token !== undefined && secretsDiffer(olds?.accessToken, token)) {
        return { action: "update" } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const scope =
        output !== undefined
          ? { type: output.scopeType, id: output.scopeId }
          : yield* resolveScope(olds?.scope);
      const region = output?.region ?? olds?.region ?? env.region;
      const link = yield* observe(linkApi(scope, region));
      if (link === undefined) return undefined;
      const attrs = toAttrs(scope, region, link);
      const isPrevious =
        previous?.linkId === link.id &&
        previous.scopeType === scope.type &&
        previous.scopeId === scope.id &&
        previous.region === region;
      if (isPrevious) return attrs;
      return (yield* hasAlchemyLabels(id, link.resourceLabels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, fqn, news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const scope = yield* resolveScope(news.scope);
      const region = news.region ?? env.region;
      const api = linkApi(scope, region);
      const resource = `STACKIT Telemetry link of ${scope.type} ${scope.id} (${region})`;
      const desired: DesiredLink = {
        routerId: news.routerId,
        displayName: news.displayName ?? (yield* generatedDisplayName(id)),
        description: news.description,
        enabled: news.enabled ?? true,
        labels: yield* desiredLabels(id, news.labels),
      };

      // 1. Observe — the scope and region are the identity. `read` doesn't run for a row in
      // state, so a link that took over the scope since the last deploy is caught here.
      let current = yield* observe(api);
      if (
        current !== undefined &&
        output !== undefined &&
        !(yield* isOurLink(id, current, output)) &&
        !(yield* adoptAllowed(fqn))
      ) {
        return yield* new OwnedBySomeoneElse({
          message: `${resource} is ${current.id}, not the ${output.linkId} this stack deployed, and it isn't Alchemy's. Re-run with \`--adopt\` to take it over.`,
          resourceType: Link.Type,
          logicalId: id,
          physicalName: current.id,
        });
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.status === "deleting") {
        yield* waitUntilGone({
          resource,
          read: observe(api),
          state: (link) => link.status,
          timeout: LINK_TIMEOUT,
          ...POLL,
        });
        current = undefined;
      }

      // 2. Ensure — `If-None-Match` so a link someone just created is never overwritten.
      let tokenSent = false;
      if (current === undefined) {
        const accessToken = news.accessToken;
        if (accessToken === undefined) {
          return yield* new LinkAccessTokenMissing({
            resource,
            message: `${resource} can't be created: its accessToken has no known value`,
          });
        }
        tokenSent = true;
        current = yield* api
          .create({
            ifNoneMatch: "*",
            accessToken,
            displayName: desired.displayName,
            telemetryRouterId: desired.routerId,
            enabled: desired.enabled,
            resourceLabels: desired.labels,
            ...(desired.description !== undefined ? { description: desired.description } : {}),
          })
          .pipe(
            // A concurrent create of this link is a race to observe. Anyone else's link
            // still fails: taking it over is `--adopt`'s decision.
            Effect.catchTag("PreconditionFailed", (error) =>
              Effect.gen(function* () {
                const raced = yield* observe(api);
                if (raced !== undefined && (yield* hasAlchemyLabels(id, raced.resourceLabels))) {
                  return raced;
                }
                return yield* Effect.fail(error);
              }),
            ),
          );
      }

      // Wait out an in-flight change before syncing: it would answer a PATCH with a 409.
      if (current.status === "reconciling") {
        current = yield* waitFor({
          resource,
          read: api.get,
          ready: (link) => link.status !== "reconciling",
          failed: (link) => (link.status === "deleting" ? link.status : undefined),
          state: (link) => link.status,
          timeout: LINK_TIMEOUT,
          ...POLL,
        });
      }

      // 3. Sync — the delta against the observed link. The API never reports the token
      // as a source of truth, so `olds` is the only hint that it is unchanged. A failed
      // link is patched even with nothing drifted, so it either recovers or the deploy
      // fails; it is never returned as if it were healthy.
      const delta = linkDelta(current, desired);
      const token =
        !tokenSent &&
        news.accessToken !== undefined &&
        (olds?.accessToken === undefined || secretsDiffer(olds.accessToken, news.accessToken))
          ? { accessToken: news.accessToken }
          : {};
      const patch: LinkPatch = { ...delta, ...token };
      const patched = Object.keys(patch).length > 0 || current.status === "failed";
      if (patched) {
        yield* api
          .patch(Object.keys(patch).length > 0 ? patch : { enabled: desired.enabled })
          .pipe(Effect.retry(conflictRetry));
      }

      // 4. Return — once settled with the desired values, so a read from before the PATCH
      // can't pass. A `failed` read right after a repairing PATCH can predate it.
      let staleFailedPolls = patched ? STALE_FAILED_POLLS : 0;
      const settled = yield* waitFor({
        resource,
        read: api.get,
        // The Go SDK's handlers only know `active`. Nothing says a disabled link reports
        // `inactive` rather than staying `active`, and that must not stall a deploy.
        ready: (link) =>
          applied(link, desired) &&
          (link.status === "active" || (!desired.enabled && link.status === "inactive")),
        failed: (link) => {
          if (link.status === "deleting") return link.status;
          if (link.status !== "failed") return undefined;
          return staleFailedPolls-- > 0 ? undefined : link.status;
        },
        state: (link) => link.status,
        timeout: LINK_TIMEOUT,
        ...POLL,
      });
      return toAttrs(scope, region, settled);
    }),

    delete: Effect.fn(function* ({ id, output }) {
      const scope = { type: output.scopeType, id: output.scopeId };
      const api = linkApi(scope, output.region);
      const live = yield* observe(api);
      // Ours went out of band, and what holds the scope now is someone else's.
      if (live === undefined || !(yield* isOurLink(id, live, output))) return;
      if (live.status !== "deleting") {
        yield* api.remove.pipe(
          // The spec: "modified by some other client, please try again".
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
      yield* waitUntilGone({
        resource: `STACKIT Telemetry link of ${scope.type} ${scope.id} (${output.region})`,
        read: observe(api),
        state: (link) => link.status,
        timeout: LINK_TIMEOUT,
        ...POLL,
      });
    }),
  });
