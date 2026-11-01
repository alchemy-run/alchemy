import * as lb from "@distilled.cloud/stackit/load_balancer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";

/** Service id the load balancer API needs enabled per project. */
export const LOAD_BALANCER_SERVICE_ID = "cloud.stackit.loadbalancer";

/**
 * Load balancer names and credential display names both accept
 * `[0-9a-z-]`; generated ones stay within the shorter limit (63), so `list`
 * can recognize a generated credential name.
 */
export const NAME_MAX_LENGTH = 63;

/** Physical name for a load balancer or an observability credential. */
export const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: NAME_MAX_LENGTH, lowercase: true });

/** Far beyond any project quota; keeps a server-side paging bug from looping forever. */
const MAX_LIST_PAGES = 100;

/** Every load balancer of a project and region, across all pages. */
export const listAllLoadBalancers = (scope: ProjectScope) =>
  Effect.gen(function* () {
    const all: lb.LoadBalancer2[] = [];
    let pageId: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = yield* lb.listLoadBalancers({
        ...scope,
        pageSize: "100",
        ...(pageId !== undefined ? { pageId } : {}),
      });
      all.push(...(response.loadBalancers ?? []));
      pageId = response.nextPageId === "" ? undefined : response.nextPageId;
      if (pageId === undefined) break;
    }
    return all;
  });

/** `GetLoadBalancer`; `undefined` when the load balancer is gone. */
export const getLoadBalancerOrUndefined = (scope: ProjectScope, name: string) =>
  lb.getLoadBalancer({ ...scope, name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Whether `observed` already holds everything `desired` sets, recursively.
 * Lists compare as multisets of the same length (order is not meaningful and
 * STACKIT may return another order). Fields `desired` leaves out are ignored,
 * so server-computed values (a listener's `name`, default timeouts) never count
 * as drift. `false` matches an omitted field, since the API may drop it.
 */
export const covers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    const candidates: unknown[] = Array.isArray(observed) ? [...observed] : [];
    if (candidates.length !== desired.length) return false;
    return desired.every((item) => {
      const index = candidates.findIndex((candidate) => covers(item, candidate));
      if (index < 0) return false;
      candidates.splice(index, 1);
      return true;
    });
  }
  if (typeof desired === "object" && desired !== null) {
    const fields: Readonly<Record<string, unknown>> =
      typeof observed === "object" && observed !== null
        ? (observed as Readonly<Record<string, unknown>>)
        : {};
    return Object.entries(desired).every(([key, value]) => covers(value, fields[key]));
  }
  return desired === observed || (desired === false && observed === undefined);
};
