import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  createChildName,
  isServerOwnedByStack,
  lower,
  sameSecret,
} from "./common.ts";
import {
  jobAgentPath,
  type JobAgentScope,
  retryWhileAgentBusy,
  secretsFingerprint,
} from "./setting.ts";

export interface JobCredentialProps {
  /** Resource group of the server. Changing it replaces the credential. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the credential. */
  server: string;
  /** Name of the elastic job agent. Changing it replaces the credential. */
  jobAgent: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the credential.
   */
  name?: string;
  /** SQL login the agent uses to connect to job targets. */
  username: string;
  /**
   * Password of the SQL login. Write-only: Alchemy stores a salted fingerprint and only
   * re-sends it when it changes.
   */
  password: Redacted.Redacted<string>;
}

export interface JobCredential extends Resource<
  "Azure.Sql.JobCredential",
  JobCredentialProps,
  {
    /** Name of the credential. */
    credentialName: string;
    /** ARM resource ID of the credential. */
    credentialId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the elastic job agent. */
    jobAgentName: string;
    /** SQL login of the credential. */
    username: string;
    /** Salted fingerprint of the write-only secrets Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A database-scoped credential of an elastic job agent — the SQL login
 * the agent uses to connect to target databases (alternatively, give the
 * agent a user-assigned managed identity).
 *
 * The password is write-only; Alchemy stores a salted fingerprint and
 * re-sends it only when it changes.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-jobs-tutorial
 *
 * ### Creating a Credential
 * **Example:** SQL login for job targets
 * ```typescript
 * const credential = yield* Azure.Sql.JobCredential("job-login", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   jobAgent: agent.jobAgentName,
 *   username: "jobuser",
 *   password: Redacted.make(jobUserPassword),
 * });
 * ```
 *
 * @resource
 */
export const JobCredential = Resource<JobCredential>("Azure.Sql.JobCredential");

type Observed = sql.GetJobCredentialsResponse;

const getChild = (subscriptionId: string, scope: JobAgentScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetJobCredentials({
      ...jobAgentPath(subscriptionId, scope),
      credentialName: name,
    }),
  );

const toAttrs = (
  scope: JobAgentScope,
  name: string,
  observed: Observed,
  fingerprint: Redacted.Redacted<string> | undefined,
): JobCredential["Attributes"] => ({
  credentialName: name,
  credentialId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  jobAgentName: scope.jobAgentName,
  username: observed.properties?.username ?? "",
  secretFingerprint: fingerprint,
});

export const JobCredentialProvider = () =>
  Provider.succeed(JobCredential, {
    stables: [
      "credentialName",
      "credentialId",
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
          lower(news.name) !== lower(output.credentialName))
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
      const name = output?.credentialName ?? olds?.name ?? generated;
      const observed = yield* getChild(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed, output?.secretFingerprint);
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
        output?.credentialName ??
        (yield* createChildName(id, 128));
      const fingerprint = yield* secretsFingerprint(
        `${scope.resourceGroup}/${name}/JobCredential`,
        [news.password],
      );
      const desired = { username: news.username };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !(observed.properties?.username === desired.username) ||
        !sameSecret(fingerprint, output?.secretFingerprint)
      ) {
        yield* retryWhileAgentBusy(
          sql.JobCredentialsCreateOrUpdate({
            ...jobAgentPath(subscriptionId, scope),
            credentialName: name,
            properties: { ...desired, password: news.password },
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `sql job credential ${name}`,
        get,
        (observed) =>
          observed.properties?.username === desired.username
            ? "Succeeded"
            : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryWhileAgentBusy(
          sql.DeleteJobCredentials({
            ...jobAgentPath(subscriptionId, output),
            credentialName: output.credentialName,
          }),
        ),
      );
      yield* waitUntilGone(
        `sql job credential ${output.credentialName}`,
        getChild(subscriptionId, output, output.credentialName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
