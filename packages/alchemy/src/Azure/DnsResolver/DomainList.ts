import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDnsResolverName,
  FAST_BUDGET,
  sameArm,
  whileNestedResourcesExist,
} from "./Common.ts";

export interface DomainListProps {
  /**
   * Resource group the domain list is created in. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the list.
   */
  resourceGroup: string;
  /**
   * Domain list name: 1-80 letters, digits, `_`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the list.
   */
  name?: string;
  /**
   * Azure location of the list; must match the DNS security policies that
   * reference it. Changing it replaces the list.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Fully qualified domains, each ending with a dot (e.g.
   * `malicious.example.com.`). A domain also matches its subdomains; use
   * `.` to match every domain.
   */
  domains: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DomainList extends Resource<
  "Azure.DnsResolver.DomainList",
  DomainListProps,
  {
    /** Name of the domain list. */
    domainListName: string;
    /** ARM resource ID of the list; reference it from DNS security rules. */
    domainListId: string;
    /** Resource group that holds the list. */
    resourceGroup: string;
    /** Location of the list. */
    location: string;
    /** Domains in the list. */
    domains: string[];
    /** Immutable GUID Azure assigns to the list. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DNS resolver domain list — a named set of domains that DNS
 * security rules allow, alert on, or block.
 *
 * @see https://learn.microsoft.com/azure/dns/dns-security-policy
 *
 * ### Creating a Domain List
 * **Example:** Block list of known-bad domains
 * ```typescript
 * const blocked = yield* Azure.DnsResolver.DomainList("blocked", {
 *   resourceGroup: group.resourceGroupName,
 *   domains: ["malicious.example.com.", "phishing.example.net."],
 * });
 * ```
 *
 * @resource
 */
export const DomainList = Resource<DomainList>("Azure.DnsResolver.DomainList");

const getList = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverDomainListName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetDnsResolverDomainList({
      subscriptionId,
      resourceGroupName,
      dnsResolverDomainListName,
    }),
  );

const sameDomains = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const norm = (domains: ReadonlyArray<string>) =>
    [...new Set(domains.map((domain) => domain.toLowerCase()))]
      .sort()
      .join("\n");
  return norm(a) === norm(b);
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  list:
    | dnsresolver.GetDnsResolverDomainListResponse
    | dnsresolver.DnsResolverDomainList,
): DomainList["Attributes"] => ({
  domainListName: name,
  domainListId: list.id ?? "",
  resourceGroup,
  location: list.location,
  domains: [...(list.properties?.domains ?? [])],
  resourceGuid: list.properties?.resourceGuid,
  tags: userTags(list.tags),
});

export const DomainListProvider = () =>
  Provider.succeed(DomainList, {
    stables: [
      "domainListName",
      "domainListId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dnsresolver
        .ListDnsResolverDomainLists({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDnsResolverDomainLists", page),
          ),
        );
      return (page.value ?? []).flatMap((list) => {
        const group = resourceGroupOf(list.id);
        return hasAnyAlchemyTag(list.tags) &&
          group !== undefined &&
          list.name !== undefined
          ? [toAttrs(group, list.name, list)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.domainListName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.domainListName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getList(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.domainListName ??
        (yield* createDnsResolverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverDomainListName: name,
      };
      const get = getList(subscriptionId, resourceGroup, name);
      const label = `DNS resolver domain list ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dnsresolver.DnsResolverDomainListsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { domains: news.domains },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (list) => list.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync domains and tags against observed state.
      const domainsChanged = !sameDomains(
        observed.properties?.domains ?? [],
        news.domains,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (domainsChanged || tagsChanged) {
        yield* dnsresolver.UpdateDnsResolverDomainList({
          ...where,
          properties: domainsChanged ? { domains: news.domains } : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (list) =>
            tagsDiffer(list.tags, tags) ||
            !sameDomains(list.properties?.domains ?? [], news.domains)
              ? "Updating"
              : list.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver
          .DeleteDnsResolverDomainList({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            dnsResolverDomainListName: output.domainListName,
          })
          .pipe(Effect.retry(whileNestedResourcesExist)),
      );
      yield* waitUntilGone(
        `DNS resolver domain list ${output.domainListName}`,
        getList(subscriptionId, output.resourceGroup, output.domainListName),
        FAST_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
