import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { ContainerApp } from "./ContainerApp.ts";
import type { Job } from "./Job.ts";

/**
 * Shared scaffolding for the Container Apps runtime-action bindings (start
 * and stop an app, restart a revision, start, stop, suspend, and resume a
 * job from a running host). NOT exported from `index.ts`: every
 * `{Op}Http.ts` is a thin `Layer.effect(Cap, make…({ … }))`.
 *
 * The smallest built-in roles (**Container Apps Contributor**, and for jobs
 * **Container Apps Jobs Operator**) grant more than one action, so each
 * binding kind gets a custom role (`Azure.Authorization.RoleDefinition`, one
 * per stack, defined at the subscription) with exactly its action, assigned
 * only on the bound app or job.
 */

const APPS = "Microsoft.App/containerApps";
const JOBS = "Microsoft.App/jobs";

/** A custom role a binding assigns on its resource; the logical ID is `AzureContainerApps<role>Role`. */
export interface ContainerAppsGrant {
  readonly role: string;
  readonly actions: readonly string[];
}

/** Custom role per runtime action (Azure RBAC operation names). */
export const ContainerAppsRole = {
  ContainerAppStart: { role: "ContainerAppStart", actions: [`${APPS}/start/action`] },
  ContainerAppStop: { role: "ContainerAppStop", actions: [`${APPS}/stop/action`] },
  RevisionRestart: { role: "RevisionRestart", actions: [`${APPS}/revisions/restart/action`] },
  JobStart: { role: "JobStart", actions: [`${JOBS}/start/action`] },
  JobExecutionStop: { role: "JobExecutionStop", actions: [`${JOBS}/stop/execution/action`] },
  JobSuspend: { role: "JobSuspend", actions: [`${JOBS}/suspend/action`] },
  JobResume: { role: "JobResume", actions: [`${JOBS}/resume/action`] },
} as const satisfies Record<string, ContainerAppsGrant>;

/** Attach the binding to its host and assign `grant` on the bound resource. */
const GrantOnResource = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: ResourceLike,
    scope: Output.Output<string, never>,
    grant: ContainerAppsGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureContainerApps${grant.role}Role`, {
        description: `Alchemy Container Apps binding: ${grant.actions.join(", ")}`,
        permissions: [{ actions: [...grant.actions] }],
      });
      yield* bind`${tag}(${resource})`({
        roleAssignments: [{ roleDefinitionId: role.roleDefinitionId, scope }],
      });
    }
  });
});

/** Subscription, resource group, and name of an ARM resource ID. */
const parseResourceId = (resourceId: string) => {
  const parts = resourceId.split("/");
  return {
    subscriptionId: parts[2] ?? "",
    resourceGroupName: parts[4] ?? "",
    name: parts[parts.length - 1] ?? "",
  };
};

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

type ContainerAppKeys = "subscriptionId" | "resourceGroupName" | "containerAppName";

/**
 * Build the impl Effect for an action on a {@link ContainerApp}: the runtime
 * callable injects the app's subscription, resource group, and name (parsed
 * from its ARM ID), and the deploy-time half assigns `grant` on the app.
 */
export const makeContainerAppActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; containerAppName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ContainerApps.StartContainerApp`. */
  tag: string;
  /** The distilled operation; the app's identifiers are injected. */
  operation: Operation<I, A, E>;
  /** Custom role assigned on the app. */
  grant: ContainerAppsGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnResource;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (app: ContainerApp) {
      yield* grant(options.tag, app, app.containerAppId, options.grant);
      const containerAppId = yield* app.containerAppId;
      return Effect.fn(`${options.tag}(${app.LogicalId})`)(function* (
        request?: Omit<I, ContainerAppKeys>,
      ) {
        const id = yield* containerAppId;
        const { subscriptionId, resourceGroupName, name } = parseResourceId(id);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({
          ...request,
          subscriptionId,
          resourceGroupName,
          containerAppName: name,
        } as I);
      });
    });
  });

type JobKeys = "subscriptionId" | "resourceGroupName" | "jobName";

/**
 * Build the impl Effect for an action on a Container Apps {@link Job}: the
 * runtime callable injects the job's subscription, resource group, and name,
 * and the deploy-time half assigns `grant` on the job.
 */
export const makeJobActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; jobName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.ContainerApps.StartJob`. */
  tag: string;
  /** The distilled operation; the job's identifiers are injected. */
  operation: Operation<I, A, E>;
  /** Custom role assigned on the job. */
  grant: ContainerAppsGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnResource;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (job: Job) {
      yield* grant(options.tag, job, job.jobId, options.grant);
      const jobId = yield* job.jobId;
      return Effect.fn(`${options.tag}(${job.LogicalId})`)(function* (request?: Omit<I, JobKeys>) {
        const id = yield* jobId;
        const { subscriptionId, resourceGroupName, name } = parseResourceId(id);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, subscriptionId, resourceGroupName, jobName: name } as I);
      });
    });
  });
