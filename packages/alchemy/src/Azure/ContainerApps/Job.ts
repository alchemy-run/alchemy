import * as app from "@distilled.cloud/azure/app";
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
  createContainerAppsName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  secretsMatch,
  toIdentity,
  toSecrets,
  type ContainerAppsIdentity,
  type ContainerAppsSecret,
} from "./common.ts";

/**
 * Job configuration: trigger type (`Manual`, `Schedule`, `Event`) and its
 * trigger config, replica timeout and retries, registries. Secrets are set
 * with the separate `secrets` prop.
 */
export type JobConfiguration = Omit<app.JobConfiguration, "secrets">;

/** Job template: containers, init containers, volumes. */
export type JobTemplate = app.JobTemplateInput;

export interface JobProps {
  /** Resource group the job is created in. Changing it replaces the job. */
  resourceGroup: string;
  /**
   * Job name: 2-32 lowercase letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the job.
   */
  name?: string;
  /**
   * Azure location; must match the environment's location. Changing it
   * replaces the job.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Container Apps environment (`environment.environmentId`).
   * Changing it replaces the job.
   */
  environmentId: string;
  /**
   * Workload profile of the environment to run on.
   * @default the environment's Consumption profile
   */
  workloadProfileName?: string;
  /** Trigger, timeout, retry, and registry configuration. */
  configuration: JobConfiguration;
  /** Containers each job execution runs. */
  template: JobTemplate;
  /** Secrets referenced by env vars, registries, and scale rules. */
  secrets?: ContainerAppsSecret[];
  /** Managed identity of the job. */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Job extends Resource<
  "Azure.ContainerApps.Job",
  JobProps,
  {
    /** Name of the job. */
    jobName: string;
    /** ARM resource ID of the job; use it as a role-assignment scope. */
    jobId: string;
    /** Resource group that holds the job. */
    resourceGroup: string;
    /** Location of the job. */
    location: string;
    /** ARM ID of the environment the job runs in. */
    environmentId: string;
    /** Trigger type of the job. */
    triggerType: string;
    /** Outbound IP addresses of the job. */
    outboundIpAddresses: string[];
    /** Event stream endpoint of the job. */
    eventStreamEndpoint: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Apps job (`Microsoft.App/jobs`) — containers that run
 * to completion on demand (`Manual`), on a cron schedule (`Schedule`), or
 * when a KEDA scaler sees events (`Event`).
 *
 * @see https://learn.microsoft.com/azure/container-apps/jobs
 *
 * ### Creating a Job
 * **Example:** Manually triggered job
 * ```typescript
 * const job = yield* Azure.ContainerApps.Job("migrate", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   configuration: {
 *     triggerType: "Manual",
 *     replicaTimeout: 300,
 *     manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
 *   },
 *   template: {
 *     containers: [
 *       {
 *         name: "migrate",
 *         image: "mcr.microsoft.com/k8se/quickstart-jobs:latest",
 *         resources: { cpu: 0.25, memory: "0.5Gi" },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Scheduled Jobs
 * **Example:** Run every night at 02:00 UTC
 * ```typescript
 * const nightly = yield* Azure.ContainerApps.Job("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   configuration: {
 *     triggerType: "Schedule",
 *     replicaTimeout: 1800,
 *     scheduleTriggerConfig: { cronExpression: "0 2 * * *" },
 *   },
 *   template: { containers: [{ name: "report", image }] },
 * });
 * ```
 *
 * @resource
 */
export const Job = Resource<Job>("Azure.ContainerApps.Job");

const createJobName = (id: string) => createContainerAppsName(id, 32);

const getJob = (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
) =>
  orUndefinedIfNotFound(
    app.GetJob({ subscriptionId, resourceGroupName, jobName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetJobResponse,
): Job["Attributes"] => ({
  jobName: name,
  jobId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  environmentId: observed.properties?.environmentId ?? "",
  triggerType: observed.properties?.configuration?.triggerType ?? "",
  outboundIpAddresses: [...(observed.properties?.outboundIpAddresses ?? [])],
  eventStreamEndpoint: observed.properties?.eventStreamEndpoint,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

/** The desired `properties` body (secret values revealed). */
const toProperties = (props: JobProps): app.JobPropertiesInput => ({
  environmentId: props.environmentId,
  workloadProfileName: props.workloadProfileName,
  configuration: { ...props.configuration, secrets: toSecrets(props.secrets) },
  template: props.template,
});

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["jobName", "jobId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListJobBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListJobBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.jobName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.environmentId) !== lower(output.environmentId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.jobName ?? olds?.name ?? (yield* createJobName(id));
      const observed = yield* getJob(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.jobName ?? (yield* createJobName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        jobName: name,
      };
      const get = getJob(subscriptionId, resourceGroup, name);
      const put = app.JobsCreateOrUpdate({
        ...where,
        location,
        tags,
        identity: toIdentity(news.identity),
        properties,
      });
      const ready = waitForProvisioned(
        `container apps job ${name}`,
        get,
        (job) => job.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT carries the full desired state.
      if (observed === undefined) {
        yield* put;
        observed = yield* ready;
      } else {
        observed = yield* ready;
        // Sync against the observed job; secrets via `listSecrets`, removed
        // properties against the previous props.
        const secrets = toSecrets(news.secrets);
        const configuration = news.configuration;
        const observedSecrets =
          secrets.length > 0 ||
          (observed.properties?.configuration?.secrets ?? []).length > 0
            ? (yield* orUndefinedIfNotFound(app.ListJobSecrets(where)))?.value
            : [];
        const inSync =
          matchesDesired(
            { ...properties, configuration },
            observed.properties,
          ) &&
          secretsMatch(secrets, observedSecrets) &&
          identityMatches(news.identity, observed.identity) &&
          !tagsDiffer(observed.tags, tags) &&
          (olds === undefined ||
            fingerprint(properties) === fingerprint(toProperties(olds)));
        if (!inSync) {
          yield* put;
          observed = yield* ready;
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteJob({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          jobName: output.jobName,
        }),
      );
      yield* waitUntilGone(
        `container apps job ${output.jobName}`,
        getJob(subscriptionId, output.resourceGroup, output.jobName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerApps.ManagedEnvironment",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
