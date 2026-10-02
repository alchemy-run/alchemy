import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
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
import {
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  whileClusterBusy,
} from "./common.ts";

export interface ScriptProps {
  /** Resource group of the cluster. Changing it replaces the script. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the script. */
  cluster: string;
  /** Name of the database the script runs in. Changing it replaces the script. */
  database: string;
  /**
   * Script name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the script.
   */
  name?: string;
  /**
   * Inline KQL control commands to run, e.g.
   * `.create-merge table Events (Timestamp: datetime, Name: string)`.
   * Azure does not return the content on read; editing it re-runs the
   * script. Set either `content` or `scriptUrl`.
   */
  content?: string;
  /** URL of a blob holding the script. Set either `content` or `scriptUrl`. */
  scriptUrl?: string;
  /** SAS token granting read access to `scriptUrl`. */
  scriptUrlSasToken?: string;
  /**
   * Changing this value re-runs the script.
   * @default a SHA-256 hash of `content` (or `scriptUrl`), so edits re-run it
   */
  forceUpdateTag?: string;
  /**
   * Continue with the next command when a command fails.
   * @default false
   */
  continueOnErrors?: boolean;
  /**
   * Whether the script runs at `Database` or `Cluster` level. Changing it
   * replaces the script.
   * @default "Database"
   */
  scriptLevel?: "Database" | "Cluster";
  /**
   * Whether the script's principal keeps its permissions after the script
   * completes.
   */
  principalPermissionsAction?:
    | "RetainPermissionOnScriptCompletion"
    | "RemovePermissionOnScriptCompletion";
  /** Resource ID of the managed identity used to download `scriptUrl`. */
  managedIdentityResourceId?: string;
}

export interface Script extends Resource<
  "Azure.Kusto.Script",
  ScriptProps,
  {
    /** Name of the script. */
    scriptName: string;
    /** ARM resource ID of the script. */
    scriptId: string;
    /** Cluster of the database. */
    cluster: string;
    /** Database the script runs in. */
    database: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Tag of the last applied run; a new tag re-runs the script. */
    forceUpdateTag: string;
    /** Whether failing commands were skipped. */
    continueOnErrors: boolean;
  },
  never,
  Providers
> {}

/**
 * A KQL script of control commands run against an Azure Data Explorer
 * (Kusto) database — the declarative way to create tables, ingestion
 * mappings, functions, and policies. The script re-runs whenever its
 * content changes. Deleting the script removes only the ARM record; the
 * objects it created stay in the database.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/database-script
 *
 * ### Creating Tables
 * **Example:** Create a table and a JSON ingestion mapping
 * ```typescript
 * const schema = yield* Azure.Kusto.Script("schema", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   database: db.databaseName,
 *   content: [
 *     ".create-merge table Events (Timestamp: datetime, Name: string)",
 *     ".create-or-alter table Events ingestion json mapping 'EventsMapping' '[{\"column\":\"Timestamp\",\"path\":\"$.ts\"},{\"column\":\"Name\",\"path\":\"$.name\"}]'",
 *   ].join("\n"),
 * });
 * ```
 *
 * @resource
 */
export const Script = Resource<Script>("Azure.Kusto.Script");

const getScript = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
  scriptName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetScript({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
      scriptName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  database: string,
  name: string,
  script: kusto.GetScriptResponse,
): Script["Attributes"] => ({
  scriptName: name,
  scriptId: script.id ?? "",
  cluster,
  database,
  resourceGroup,
  forceUpdateTag: script.properties?.forceUpdateTag ?? "",
  continueOnErrors: script.properties?.continueOnErrors ?? false,
});

const contentTag = (source: string) =>
  Effect.sync(() => createHash("sha256").update(source).digest("hex"));

export const ScriptProvider = () =>
  Provider.succeed(Script, {
    stables: ["scriptName", "scriptId", "cluster", "database", "resourceGroup"],

    // Scripts live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        news.database !== output.database ||
        (news.name !== undefined && news.name !== output.scriptName) ||
        (olds !== undefined &&
          (news.scriptLevel ?? "Database") !== (olds.scriptLevel ?? "Database"))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const database = output?.database ?? olds?.database;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        database === undefined
      ) {
        return undefined;
      }
      const name =
        output?.scriptName ?? olds?.name ?? (yield* createKustoChildName(id));
      const observed = yield* getScript(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, database, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster, database } = news;
      const name =
        news.name ?? output?.scriptName ?? (yield* createKustoChildName(id));
      const forceUpdateTag =
        news.forceUpdateTag ??
        (yield* contentTag(news.content ?? news.scriptUrl ?? ""));
      const continueOnErrors = news.continueOnErrors ?? false;
      const get = getScript(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );

      // Observe. The content is write-only, so the tag stands in for it.
      const observed = yield* get;

      // Ensure + sync: the PUT creates the script and re-runs it on change.
      if (
        observed === undefined ||
        observed.properties?.forceUpdateTag !== forceUpdateTag ||
        (observed.properties?.continueOnErrors ?? false) !== continueOnErrors ||
        (news.principalPermissionsAction !== undefined &&
          observed.properties?.principalPermissionsAction !==
            news.principalPermissionsAction)
      ) {
        yield* kusto
          .ScriptsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            clusterName: cluster,
            databaseName: database,
            scriptName: name,
            properties: {
              scriptContent: news.content,
              scriptUrl: news.scriptUrl,
              scriptUrlSasToken: news.scriptUrlSasToken,
              forceUpdateTag,
              continueOnErrors,
              scriptLevel: news.scriptLevel,
              principalPermissionsAction: news.principalPermissionsAction,
              managedIdentityResourceId: news.managedIdentityResourceId,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      const fresh = yield* waitForProvisioned(
        `kusto script ${name}`,
        get,
        (s) => s.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, database, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteScript({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            databaseName: output.database,
            scriptName: output.scriptName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto script ${output.scriptName}`,
        getScript(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.database,
          output.scriptName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
