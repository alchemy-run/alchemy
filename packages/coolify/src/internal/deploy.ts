import * as Coolify from "@distilled.cloud/coolify";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Coolify's terminal deployment statuses (`ApplicationDeploymentStatus`). */
const TERMINAL = new Set(["finished", "failed", "cancelled-by-user"]);

/** A Coolify deployment ended in `failed` or `cancelled-by-user`. */
export class DeploymentFailed extends Data.TaggedError("Coolify.DeploymentFailed")<{
  readonly message: string;
  readonly resourceUuid: string;
  readonly deploymentUuid: string;
  readonly status: string;
  /** The last lines of the deployment log, when Coolify returned one. */
  readonly logs: string | undefined;
}> {}

/** Coolify accepted a deploy request but did not queue a deployment. */
export class DeploymentNotQueued extends Data.TaggedError("Coolify.DeploymentNotQueued")<{
  readonly message: string;
  readonly resourceUuid: string;
}> {}

/** A deployment was still running when the wait ran out. */
export class DeploymentTimedOut extends Data.TaggedError("Coolify.DeploymentTimedOut")<{
  readonly message: string;
  readonly deploymentUuid: string;
  readonly status: string;
}> {}

const tailOf = (logs: string | undefined): string | undefined => {
  if (!logs) return undefined;
  // Coolify stores the log as a JSON array of { output, type, ... } lines.
  try {
    const lines = JSON.parse(logs) as Array<{ output?: string }>;
    return lines
      .map((line) => line.output ?? "")
      .filter((line) => line.length > 0)
      .slice(-20)
      .join("\n");
  } catch {
    return logs.slice(-2000);
  }
};

/**
 * Queue a deployment of one application with `POST /deploy` and wait until
 * it finishes. Fails with {@link DeploymentFailed} when the build or the
 * rollout fails, carrying the tail of the deployment log.
 *
 * The wait is bounded at about ten minutes (a cold image pull plus a
 * Dockerfile or Nixpacks build); a longer deployment fails with
 * {@link DeploymentTimedOut} and keeps running in Coolify.
 */
export const deployAndWait = Effect.fn(function* (resourceUuid: string, force: boolean) {
  const deploy = yield* Coolify.deployByTagOrUuid;
  const getDeployment = yield* Coolify.getDeployment;

  const response = yield* deploy({ uuid: resourceUuid, force });
  const deploymentUuid = response.deployments?.find(
    (d) => d.resource_uuid === resourceUuid || d.resource_uuid === undefined,
  )?.deployment_uuid;
  if (!deploymentUuid) {
    return yield* new DeploymentNotQueued({
      message: `Coolify did not queue a deployment for ${resourceUuid}: ${
        response.deployments?.[0]?.message ?? "no deployment returned"
      }`,
      resourceUuid,
    });
  }

  const deployment = yield* getDeployment({ uuid: deploymentUuid }).pipe(
    // The deployment row can lag the queue response by a moment.
    Effect.retry({
      while: (e) => e._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (d) => TERMINAL.has(d.status ?? ""),
      times: 200,
    }),
  );

  const status = deployment.status ?? "unknown";
  if (!TERMINAL.has(status)) {
    return yield* new DeploymentTimedOut({
      message: `Deployment ${deploymentUuid} is still ${status} after 10 minutes`,
      deploymentUuid,
      status,
    });
  }
  if (status !== "finished") {
    return yield* new DeploymentFailed({
      message: `Deployment ${deploymentUuid} of ${resourceUuid} ended as ${status}`,
      resourceUuid,
      deploymentUuid,
      status,
      logs: tailOf(deployment.logs),
    });
  }
  return deploymentUuid;
});
