/**
 * Shared scaffolding for the STACKIT IaaS resources (networking, compute
 * and storage). Not exported from the namespace barrel.
 */
import type * as iaas from "@distilled.cloud/stackit/iaas";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { requireOrganizationId, StackitEnvironment } from "../Environment.ts";
import { hasAlchemyLabels, isAlchemyOwned, labelsChanged } from "../Labels.ts";

/** Props shared by every project + region scoped IaaS resource. */
export interface ProjectScopedProps {
  projectId?: string;
  region?: string;
}

/** Attributes shared by every project + region scoped IaaS resource. */
export interface ProjectScope {
  projectId: string;
  region: string;
}

/**
 * Resolve the project and region of a project-scoped resource: the prop,
 * else the previously deployed value, else the profile's default.
 */
export const resolveProjectScope = Effect.fn(function* (
  news: ProjectScopedProps | undefined,
  output: ProjectScope | undefined,
) {
  const env = yield* StackitEnvironment.current;
  return {
    projectId: news?.projectId ?? output?.projectId ?? env.projectId,
    region: news?.region ?? output?.region ?? env.region,
  } satisfies ProjectScope;
});

/**
 * Whether the desired project or region differs from the deployed one.
 * Either change replaces the resource.
 */
export const projectScopeChanged = Effect.fn(function* (
  news: ProjectScopedProps,
  output: ProjectScope | undefined,
) {
  if (output === undefined) return false;
  const env = yield* StackitEnvironment.current;
  return (
    (news.projectId ?? env.projectId) !== output.projectId ||
    (news.region ?? env.region) !== output.region
  );
});

/** Props shared by every organization (+ network area) scoped IaaS resource. */
export interface OrganizationScopedProps {
  organizationId?: string;
}

/**
 * Resolve the organization id: the prop, else the deployed value, else the
 * profile's organization (a `ConfigError` when none is configured).
 */
export const resolveOrganizationId = Effect.fn(function* (
  news: OrganizationScopedProps | undefined,
  output: { organizationId: string } | undefined,
) {
  const explicit = news?.organizationId ?? output?.organizationId;
  if (explicit !== undefined) return explicit;
  const env = yield* StackitEnvironment.current;
  return yield* requireOrganizationId(env);
});

/**
 * The desired organization id for `diff`, or `undefined` when neither the
 * prop nor the profile names one.
 */
export const desiredOrganizationId = Effect.fn(function* (news: OrganizationScopedProps) {
  if (news.organizationId !== undefined) return news.organizationId;
  const env = yield* StackitEnvironment.current;
  return env.organizationId;
});

/**
 * The organization `list` (nuke) enumerates, or `undefined` when the
 * profile names none — then there is nothing in scope to enumerate.
 */
export const listOrganizationId = Effect.gen(function* () {
  const env = yield* StackitEnvironment.current;
  return env.organizationId;
});

/**
 * Physical name for an IaaS object. STACKIT IaaS names are at most 63
 * characters of `[A-Za-z0-9]` separated by single `-`, `_`, `.` or spaces.
 */
export const iaasName = Effect.fn(function* (id: string, name: string | undefined) {
  if (name !== undefined) return name;
  return yield* createPhysicalName({ id, maxLength: 63, lowercase: true });
});

/**
 * Pick the crash-recovery candidate among listed objects: the one carrying
 * this logical id's ownership labels and the expected name, and (via
 * `compatible`) able to take the desired props in place. A replacement's
 * new generation shares the logical id with the old one, so `compatible`
 * must reject anything whose replace-only aspects differ.
 */
export const findOwnedByName = <A extends { readonly name?: string; readonly labels?: unknown }>(
  id: string,
  name: string,
  items: ReadonlyArray<A>,
  compatible: (item: A) => boolean = () => true,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (item.name !== name) continue;
      if (!compatible(item)) continue;
      if (yield* hasAlchemyLabels(id, item.labels)) return item;
    }
    return undefined;
  });

/** Items that carry any Alchemy ownership marker (for `list`/nuke). */
export const ownedOnly = <A extends { readonly labels?: unknown }>(items: ReadonlyArray<A>) =>
  items.filter((item) => isAlchemyOwned(item.labels));

/**
 * The labels to send in an update, or `undefined` when the observed labels
 * already match. IaaS label updates replace the whole label map, so the
 * full desired map is sent.
 */
export const labelsPatch = (observed: unknown, desired: Record<string, string>) =>
  labelsChanged(observed, desired) ? desired : undefined;

/** Whether two string lists hold the same members (order-insensitive). */
export const sameMembers = (
  a: ReadonlyArray<string> | null | undefined,
  b: ReadonlyArray<string> | null | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

// ── Routes (network area routes and routing table routes) ──

/** Destination of a route. */
export type RouteDestination =
  | {
      /** An IPv4 CIDR destination. */
      type: "cidrv4";
      /** IPv4 CIDR, e.g. `10.20.0.0/16`. */
      value: string;
    }
  | {
      /** An IPv6 CIDR destination. */
      type: "cidrv6";
      /** IPv6 CIDR, e.g. `fd00:10::/64`. */
      value: string;
    }
  | {
      /** A prefix list destination. */
      type: "prefixlist";
      /** Id of the prefix list. */
      value: string;
    };

/** Next hop of a route. */
export type RouteNexthop =
  | {
      /** Forward to an IPv4 address. */
      type: "ipv4";
      /** The IPv4 next-hop address. */
      value: string;
    }
  | {
      /** Forward to an IPv6 address. */
      type: "ipv6";
      /** The IPv6 next-hop address. */
      value: string;
    }
  | {
      /** Route to the internet. */
      type: "internet";
    }
  | {
      /** Drop the traffic. */
      type: "blackhole";
    };

/** Copy an observed destination into the prop shape. */
export const toRouteDestination = (destination: iaas.RouteDestination): RouteDestination => ({
  ...destination,
});

/** Copy an observed next hop into the prop shape. */
export const toRouteNexthop = (nexthop: iaas.RouteNexthop): RouteNexthop =>
  nexthop.type === "ipv4" || nexthop.type === "ipv6"
    ? { type: nexthop.type, value: nexthop.value }
    : { type: nexthop.type };

/** Canonical key of a route destination + next hop. */
export const routeKey = (route: {
  readonly destination: { readonly type: string; readonly value: string };
  readonly nexthop: RouteNexthop | iaas.RouteNexthop;
}): string => {
  const hop =
    route.nexthop.type === "ipv4" || route.nexthop.type === "ipv6"
      ? `${route.nexthop.type}:${route.nexthop.value}`
      : route.nexthop.type;
  return `${route.destination.type}:${route.destination.value}->${hop}`;
};

/** Whether a deployed route's destination or next hop differs from the desired one. */
export const routeIdentityChanged = (
  news: { readonly destination: RouteDestination; readonly nexthop: RouteNexthop },
  output: { readonly destination: RouteDestination; readonly nexthop: RouteNexthop },
) => routeKey(news) !== routeKey(output);

/**
 * Crash-recovery candidate for a route (routes have no name): the listed
 * route with this logical id's ownership labels and the same destination
 * and next hop.
 */
export const findOwnedRoute = Effect.fn(function* (
  id: string,
  desired: { readonly destination: RouteDestination; readonly nexthop: RouteNexthop },
  routes: ReadonlyArray<iaas.Route>,
) {
  const key = routeKey(desired);
  for (const route of routes) {
    if (routeKey(route) !== key) continue;
    if (yield* hasAlchemyLabels(id, route.labels)) return route;
  }
  return undefined;
});

/**
 * Bounded retry for `Conflict` on deletes and updates: STACKIT answers 409
 * while a dependant (a NIC of a server being deleted, a network still
 * draining) is going away. About 50 seconds in total.
 */
export const conflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.exponential("1 second", 1.5),
  times: 8,
} as const;
