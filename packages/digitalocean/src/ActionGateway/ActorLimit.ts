import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ignoreNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

/** Calls per minute, by category. `0` blocks every call in the category. */
export interface ActorLimits {
  /** Calls to `exa_web_search`. */
  readonly webSearch?: number;
  /** Calls to `exa_web_fetch`. */
  readonly webFetch?: number;
  /** Calls to DigitalOcean's own tools. */
  readonly nativeTools?: number;
  /** Calls to every other tool. */
  readonly otherTools?: number;
}

export type ActorLimitProps = {
  /**
   * The actor: a session's `actor_id` or a connection's `user_id`, 1 to 64
   * characters from `[A-Za-z0-9._-]`. A change replaces the limits.
   */
  actorId: string;
  /** Per-minute limits. A limit can't exceed your team's. Updates in place. */
  limits: ActorLimits;
};

export type ActorLimit = Resource<
  "DigitalOcean.ActionGateway.ActorLimit",
  ActorLimitProps,
  {
    /** The actor. */
    actorId: string;
    /** The categories this resource set. */
    categories: string[];
  },
  never,
  Providers
>;

export type ActorLimitAttributes = ActorLimit["Attributes"];

/**
 * Per-minute Action Gateway call limits for one actor, below your team's
 * limits: one end user of your app can't spend the whole team's quota.
 * The actor must already exist, bound to an {@link Endpoint} or a session;
 * otherwise DigitalOcean answers `actor not found`. Destroying it clears the
 * limits it set.
 *
 * ### Limiting an Actor
 * **Example:** Cap the web searches of an endpoint's actor
 * ```typescript
 * const endpoint = yield* DigitalOcean.ActionGateway.Endpoint("Research", {
 *   tools: ["exa_web_search"],
 *   actorId: "user-42",
 * });
 * yield* DigitalOcean.ActionGateway.ActorLimit("User42", {
 *   actorId: endpoint.actorId,
 *   limits: { webSearch: 10, otherTools: 60 },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Action-Gateway
 *
 * @resource
 * @product Action Gateway
 * @category AI
 */
export const ActorLimit = Resource<ActorLimit>("DigitalOcean.ActionGateway.ActorLimit");

const CATEGORY = {
  webSearch: "LIMIT_CATEGORY_WEB_SEARCH_REQUESTS_PER_MINUTE",
  webFetch: "LIMIT_CATEGORY_WEB_FETCH_REQUESTS_PER_MINUTE",
  nativeTools: "LIMIT_CATEGORY_NATIVE_TOOL_CALLS_REQUESTS_PER_MINUTE",
  otherTools: "LIMIT_CATEGORY_NON_NATIVE_TOOL_CALLS_REQUESTS_PER_MINUTE",
} as const satisfies Record<keyof ActorLimits, DO.LimitCategory>;

const KNOWN: ReadonlyArray<DO.LimitCategory> = Object.values(CATEGORY);

const desiredOverrides = (limits: ActorLimits) =>
  (Object.keys(CATEGORY) as Array<keyof ActorLimits>).flatMap((key) => {
    const value = limits[key];
    return value === undefined
      ? []
      : [{ category: CATEGORY[key], requests_per_minute: String(value) }];
  });

// An actor with no sessions, connections or overrides reads as not found.
const observeConfigured = (actorId: string) =>
  DO.getActorLimit({ actor_id: actorId }).pipe(
    Effect.map((r) => r.configured_limits ?? []),
    Effect.catchTag("NotFound", () => Effect.succeed([] as DO.LimitOverride[])),
  );

export const ActorLimitProvider = () =>
  Provider.succeed(ActorLimit, {
    stables: ["actorId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const configured = yield* observeConfigured(output.actorId);
      const categories = configured
        .map((o) => o.category)
        .filter((c) => output.categories.includes(c));
      return categories.length === 0 ? undefined : { actorId: output.actorId, categories };
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.actorId !== olds.actorId) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const desired = desiredOverrides(news.limits);
      const configured = yield* observeConfigured(news.actorId);

      const changed = desired.filter(
        (d) =>
          !configured.some(
            (c) => c.category === d.category && c.requests_per_minute === d.requests_per_minute,
          ),
      );
      if (changed.length > 0) {
        yield* DO.updateActorLimit({ actor_id: news.actorId, overrides: changed });
      }

      // Clear only categories this resource set before and no longer wants.
      const wanted = new Set<string>(desired.map((d) => d.category));
      const stale = KNOWN.filter(
        (c) =>
          (output?.categories ?? []).includes(c) &&
          !wanted.has(c) &&
          configured.some((o) => o.category === c),
      );
      if (stale.length > 0) {
        yield* DO.deleteActorLimit({ actor_id: news.actorId, categories: stale });
      }
      return { actorId: news.actorId, categories: [...wanted] };
    }),
    delete: Effect.fn(function* ({ output }) {
      const categories = KNOWN.filter((c) => output.categories.includes(c));
      if (categories.length === 0) return;
      yield* ignoreNotFound(DO.deleteActorLimit({ actor_id: output.actorId, categories }));
    }),
  });
