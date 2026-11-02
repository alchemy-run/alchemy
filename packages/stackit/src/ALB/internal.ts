import * as alb from "@distilled.cloud/stackit/alb";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";

/** Far beyond any project quota; keeps a server-side paging bug from looping forever. */
const MAX_LIST_PAGES = 100;

/** Every Application Load Balancer of a project and region, across all pages. */
export const listAllLoadBalancers = (scope: ProjectScope) =>
  Effect.gen(function* () {
    const all: alb.LoadBalancer[] = [];
    let pageId: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = yield* alb.listLoadBalancers({
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
  alb.getLoadBalancer({ ...scope, name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
