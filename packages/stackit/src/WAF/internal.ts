import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";

/** Far beyond any project quota; keeps a server-side paging bug from looping forever. */
const MAX_LIST_PAGES = 100;

/** Every item of a paged WAF list. */
const allPages = <A, E, R>(
  fetch: (page: {
    pageSize: string;
    pageId?: string;
  }) => Effect.Effect<{ items?: ReadonlyArray<A>; nextPageId?: string }, E, R>,
) =>
  Effect.gen(function* () {
    const all: A[] = [];
    let pageId: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = yield* fetch({
        pageSize: "100",
        ...(pageId !== undefined ? { pageId } : {}),
      });
      all.push(...(response.items ?? []));
      pageId = response.nextPageId === "" ? undefined : response.nextPageId;
      if (pageId === undefined) break;
    }
    return all;
  });

/** Every WAF configuration of a project and region. */
export const listAllConfigurations = (scope: ProjectScope) =>
  allPages((page) => waf.listWAF({ ...scope, ...page }));

/** Every custom rule group of a project and region. */
export const listAllCustomRuleGroups = (scope: ProjectScope) =>
  allPages((page) => waf.listCustomRuleGroup({ ...scope, ...page }));

/** Every managed rule set of a project and region, without their rule inventory. */
export const listAllManagedRuleSets = (scope: ProjectScope) =>
  allPages((page) => waf.listManagedRuleSets({ ...scope, ...page }));

/** `GetWAF`; `undefined` when the configuration is gone. */
export const getConfigurationOrUndefined = (scope: ProjectScope, name: string) =>
  waf.getWAF({ ...scope, name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetCustomRuleGroup`; `undefined` when the rule group is gone. */
export const getCustomRuleGroupOrUndefined = (scope: ProjectScope, name: string) =>
  waf
    .getCustomRuleGroup({ ...scope, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetManagedRuleSet`; `undefined` when the rule set is gone. */
export const getManagedRuleSetOrUndefined = (scope: ProjectScope, name: string) =>
  waf
    .getManagedRuleSet({ ...scope, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
