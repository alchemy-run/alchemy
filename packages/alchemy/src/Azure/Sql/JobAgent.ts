import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  childLocation,
  createChildName,
  lower,
  readyState,
  sameId,
  skuMatches,
  type SqlSku,
} from "./common.ts";

/** Managed identity of a job agent. */
export interface JobAgentIdentity {
  /** Identity type; elastic jobs support user-assigned identities. */
  type: "None" | "UserAssigned";
  /** ARM resource IDs of user-assigned identities. */
  userAssignedIdentityIds?: string[];
}

export interface JobAgentProps {
  /** Resource group of the server. Changing it replaces the agent. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the agent. */
  server: string;
  /**
   * Agent name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the agent. ARM accepts up
   * to 128 characters, but creating an agent with a name longer than ~56
   * characters is accepted and then never completes.
   */
  name?: string;
  /**
   * Location; must equal the server's location. Changing it replaces the
   * agent.
   * @default the server's location
   */
  location?: string;
  /**
   * ARM ID of the job database (S1 or higher, or vCore) that stores job
   * metadata. Changing it replaces the agent.
   */
  databaseId: string;
  /**
   * Agent tier: `JA100`, `JA200`, `JA400`, or `JA800` (max concurrent
   * targets).
   * @default Azure's default (`JA100`)
   */
  sku?: SqlSku;
  /** User-assigned identity used to authenticate to job targets. */
  identity?: JobAgentIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface JobAgent extends Resource<
  "Azure.Sql.JobAgent",
  JobAgentProps,
  {
    /** Name of the job agent. */
    jobAgentName: string;
    /** ARM resource ID of the job agent. */
    jobAgentId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Location of the agent. */
    location: string;
    /** ARM ID of the job database. */
    databaseId: string;
    /** Agent state, e.g. `Ready`. */
    state: string | undefined;
    /** Current SKU name. */
    skuName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An elastic job agent — runs scheduled T-SQL jobs against Azure SQL
 * databases. Job metadata lives in a dedicated job database on the same
 * server.
 *
 * Creating an agent can take 20 minutes or more; Azure reports the agent
 * as missing until creation completes, and rejects other requests with
 * `ElasticJobAgentIsBusy` meanwhile (Alchemy waits and retries).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-jobs-overview
 *
 * ### Creating a Job Agent
 * **Example:** Agent with an S1 job database
 * ```typescript
 * const jobsDb = yield* Azure.Sql.Database("jobs", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   sku: { name: "S1" },
 * });
 * const agent = yield* Azure.Sql.JobAgent("agent", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   databaseId: jobsDb.databaseId,
 * });
 * ```
 *
 * ### Identity
 * **Example:** Agent authenticating with a managed identity
 * ```typescript
 * const agent = yield* Azure.Sql.JobAgent("agent", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   databaseId: jobsDb.databaseId,
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentityIds: [identity.identityId],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const JobAgent = Resource<JobAgent>("Azure.Sql.JobAgent");

const getAgent = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  jobAgentName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetJobAgent({
      subscriptionId,
      resourceGroupName,
      serverName,
      jobAgentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  name: string,
  agent: sql.GetJobAgentResponse,
): JobAgent["Attributes"] => ({
  jobAgentName: name,
  jobAgentId: agent.id ?? "",
  serverName,
  resourceGroup,
  location: agent.location,
  databaseId: agent.properties?.databaseId ?? "",
  state: agent.properties?.state,
  skuName: agent.sku?.name,
  tags: userTags(agent.tags),
});

const toIdentity = (
  identity: JobAgentIdentity | undefined,
): sql.JobAgentIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentityIds === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentityIds.map((id) => [id, {}]),
              ),
      };

const identityDiffers = (
  observed: sql.JobAgentIdentity | undefined,
  desired: JobAgentIdentity,
) => {
  if (lower(observed?.type ?? "None") !== lower(desired.type)) return true;
  const want = (desired.userAssignedIdentityIds ?? []).map(lower).sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map(lower)
    .sort();
  return want.join(",") !== have.join(",");
};

/**
 * Longer names are accepted (202) but the create never completes and GET
 * keeps answering not-found (observed with 66+ characters; 56 succeeds).
 */
const MAX_NAME_LENGTH = 48;

/**
 * Job agent creation takes about a minute; GET returns not-found until it
 * completes. The budget leaves room for a slow region.
 */
const PROVISIONING = { interval: "10 seconds", times: 270 } as const;

/** While the agent processes another request, mutations fail with a typed conflict. */
const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ElasticJobAgentIsBusy",
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

export const JobAgentProvider = () =>
  Provider.succeed(JobAgent, {
    stables: [
      "jobAgentName",
      "jobAgentId",
      "serverName",
      "resourceGroup",
      "location",
      "databaseId",
    ],

    // Job agents live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        (news.name !== undefined && news.name !== output.jobAgentName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        !sameId(news.databaseId, output.databaseId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const name =
        output?.jobAgentName ??
        olds?.name ??
        (yield* createChildName(id, MAX_NAME_LENGTH));
      const observed = yield* getAgent(
        subscriptionId,
        resourceGroup,
        serverName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name =
        news.name ??
        output?.jobAgentName ??
        (yield* createChildName(id, MAX_NAME_LENGTH));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: server,
        jobAgentName: name,
      };
      const get = getAgent(subscriptionId, resourceGroup, server, name);
      const waitReady = (
        sku?: SqlSku,
        converged: (agent: sql.GetJobAgentResponse) => boolean = () => true,
      ) =>
        waitForProvisioned(
          `sql job agent ${name}`,
          get,
          (agent) =>
            (sku !== undefined && !skuMatches(agent.sku, sku)) ||
            !converged(agent)
              ? "Updating"
              : readyState(agent.properties?.state),
          PROVISIONING,
        );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        const location = yield* childLocation(
          subscriptionId,
          resourceGroup,
          server,
          news.location ?? output?.location,
          env.location,
        );
        yield* sql
          .JobAgentsCreateOrUpdate({
            ...where,
            location,
            tags,
            sku: news.sku,
            identity: toIdentity(news.identity),
            properties: { databaseId: news.databaseId },
          })
          .pipe(Effect.retry(whileBusy));
      }
      observed = yield* waitReady();

      // Sync SKU, identity, and tags against the observed agent.
      const skuChanged =
        news.sku !== undefined && !skuMatches(observed.sku, news.sku);
      const identityChanged =
        news.identity !== undefined &&
        identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (skuChanged || identityChanged || tagsChanged) {
        yield* sql
          .UpdateJobAgent({
            ...where,
            sku: skuChanged ? news.sku : undefined,
            identity: identityChanged ? toIdentity(news.identity) : undefined,
            tags: tagsChanged ? tags : undefined,
          })
          .pipe(Effect.retry(whileBusy));
        observed = yield* waitReady(
          skuChanged ? news.sku : undefined,
          (agent) =>
            (!tagsChanged || !tagsDiffer(agent.tags, tags)) &&
            (!identityChanged ||
              news.identity === undefined ||
              !identityDiffers(agent.identity, news.identity)),
        );
      }

      return toAttrs(resourceGroup, server, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql
          .DeleteJobAgent({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            serverName: output.serverName,
            jobAgentName: output.jobAgentName,
          })
          .pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `sql job agent ${output.jobAgentName}`,
        getAgent(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.jobAgentName,
        ),
        { interval: "10 seconds", times: 90 },
      );
    }),
  });
