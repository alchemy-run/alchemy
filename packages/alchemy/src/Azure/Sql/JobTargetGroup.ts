import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createChildName, isServerOwnedByStack, lower } from "./common.ts";
import {
  jobAgentPath,
  type JobAgentScope,
  retryWhileAgentBusy,
} from "./setting.ts";

/** A member of a job target group. */
export interface JobTargetGroupMember {
  /**
   * Whether the target is included or excluded.
   * @default "Include"
   */
  membershipType?: "Include" | "Exclude";
  /** Kind of target. */
  type:
    | "SqlServer"
    | "SqlDatabase"
    | "SqlElasticPool"
    | "SqlShardMap"
    | "TargetGroup";
  /** Server of the target (fully qualified, e.g. `myserver.database.windows.net`). */
  serverName?: string;
  /** Database of a `SqlDatabase` target. */
  databaseName?: string;
  /** Elastic pool of a `SqlElasticPool` target. */
  elasticPoolName?: string;
  /** Shard map of a `SqlShardMap` target. */
  shardMapName?: string;
  /**
   * ARM ID of the job credential used to enumerate the databases of a
   * server, pool, or shard map target (omit with managed identity).
   */
  refreshCredential?: string;
}

const memberKey = (member: {
  membershipType?: string;
  type?: string;
  serverName?: string;
  databaseName?: string;
  elasticPoolName?: string;
  shardMapName?: string;
  refreshCredential?: string;
}) =>
  [
    lower(member.membershipType ?? "Include"),
    lower(member.type),
    lower(member.serverName),
    lower(member.databaseName),
    lower(member.elasticPoolName),
    lower(member.shardMapName),
    lower(member.refreshCredential),
  ].join("|");

const sameMembers = (
  observed: readonly Parameters<typeof memberKey>[0][] | undefined,
  desired: readonly Parameters<typeof memberKey>[0][],
) =>
  JSON.stringify((observed ?? []).map(memberKey).sort()) ===
  JSON.stringify(desired.map(memberKey).sort());

export interface JobTargetGroupProps {
  /** Resource group of the server. Changing it replaces the target group. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the target group. */
  server: string;
  /** Name of the elastic job agent. Changing it replaces the target group. */
  jobAgent: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the target group.
   */
  name?: string;
  /** Servers, databases, pools, or shard maps the group targets. */
  members: JobTargetGroupMember[];
}

export interface JobTargetGroup extends Resource<
  "Azure.Sql.JobTargetGroup",
  JobTargetGroupProps,
  {
    /** Name of the target group. */
    targetGroupName: string;
    /** ARM resource ID of the target group. */
    targetGroupId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the elastic job agent. */
    jobAgentName: string;
    /** Number of members in the group. */
    memberCount: number;
  },
  never,
  Providers
> {}

/**
 * A target group of an elastic job agent — the set of servers, databases,
 * elastic pools, or shard maps a job step runs against (with optional
 * exclusions).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-jobs-overview
 *
 * ### Targeting Databases
 * **Example:** Every database on a server except one
 * ```typescript
 * yield* Azure.Sql.JobTargetGroup("all-dbs", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   jobAgent: agent.jobAgentName,
 *   members: [
 *     { type: "SqlServer", serverName: "myserver.database.windows.net" },
 *     {
 *       membershipType: "Exclude",
 *       type: "SqlDatabase",
 *       serverName: "myserver.database.windows.net",
 *       databaseName: "jobs",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const JobTargetGroup = Resource<JobTargetGroup>(
  "Azure.Sql.JobTargetGroup",
);

type Observed = sql.GetJobTargetGroupResponse;

const getChild = (subscriptionId: string, scope: JobAgentScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetJobTargetGroup({
      ...jobAgentPath(subscriptionId, scope),
      targetGroupName: name,
    }),
  );

const toAttrs = (
  scope: JobAgentScope,
  name: string,
  observed: Observed,
): JobTargetGroup["Attributes"] => ({
  targetGroupName: name,
  targetGroupId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  jobAgentName: scope.jobAgentName,
  memberCount: observed.properties?.members?.length ?? 0,
});

export const JobTargetGroupProvider = () =>
  Provider.succeed(JobTargetGroup, {
    stables: [
      "targetGroupName",
      "targetGroupId",
      "resourceGroup",
      "serverName",
      "jobAgentName",
    ],

    // Children of a job agent are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.jobAgent) !== lower(output.jobAgentName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.targetGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const jobAgentName = output?.jobAgentName ?? olds?.jobAgent;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        jobAgentName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, jobAgentName };
      const generated = yield* createChildName(id, 128);
      const name = output?.targetGroupName ?? olds?.name ?? generated;
      const observed = yield* getChild(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined ||
        name === generated ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: JobAgentScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        jobAgentName: news.jobAgent,
      };
      const name =
        news.name ??
        output?.targetGroupName ??
        (yield* createChildName(id, 128));
      const desired = {
        members: news.members.map((member) => ({
          ...member,
          membershipType: member.membershipType ?? "Include",
        })),
      };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !sameMembers(observed.properties?.members, desired.members)
      ) {
        yield* retryWhileAgentBusy(
          sql.JobTargetGroupsCreateOrUpdate({
            ...jobAgentPath(subscriptionId, scope),
            targetGroupName: name,
            properties: desired,
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `sql job target group ${name}`,
        get,
        (observed) =>
          sameMembers(observed.properties?.members, desired.members)
            ? "Succeeded"
            : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryWhileAgentBusy(
          sql.DeleteJobTargetGroup({
            ...jobAgentPath(subscriptionId, output),
            targetGroupName: output.targetGroupName,
          }),
        ),
      );
      yield* waitUntilGone(
        `sql job target group ${output.targetGroupName}`,
        getChild(subscriptionId, output, output.targetGroupName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
