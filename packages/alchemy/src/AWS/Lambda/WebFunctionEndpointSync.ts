/**
 * Endpoint reconciliation shared by `AWS.Lambda.WebFunction` (its built-in
 * endpoint) and `AWS.Lambda.WebFunctionEndpoint` (additional endpoints).
 *
 * NOT exported from `index.ts`.
 */
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual } from "../../Diff.ts";
import { AWSEnvironment } from "../Environment.ts";

export class WebFunctionNotReady extends Data.TaggedError("WebFunctionNotReady")<{
  functionName: string;
  resource: string;
  state?: string;
}> {
  override get message() {
    return `Lambda web function ${this.functionName}: ${this.resource} is ${this.state ?? "not ready"}`;
  }
}

export class WebFunctionFailed extends Data.TaggedError("WebFunctionFailed")<{
  functionName: string;
  resource: string;
  reason?: string;
}> {
  override get message() {
    return `Lambda web function ${this.functionName}: ${this.resource} failed: ${this.reason ?? "unknown reason"}`;
  }
}

export type WebFunctionAuthType = "ApplicationManaged" | "IamAuth";

/** The settings of one endpoint, as declared on either resource. */
export interface WebFunctionEndpointSpec {
  endpointName: string;
  authType: WebFunctionAuthType;
  regions?: readonly string[];
  maxEnvironments?: number;
  rateLimit?: number;
  description?: string;
}

export type WebFunctionEndpointType = "HomeRegion" | "MultiRegion";

export const endpointTypeOf = (regions: readonly string[] | undefined): WebFunctionEndpointType =>
  regions !== undefined && regions.length > 0 ? "MultiRegion" : "HomeRegion";

export const normalizeRegions = (regions: readonly string[] | undefined) =>
  [...new Set(regions ?? [])].sort();

/** Endpoint type and Regions are immutable: changing them recreates the endpoint. */
export const endpointIdentityChanged = (
  olds: { regions?: readonly string[] },
  news: { regions?: readonly string[] },
) =>
  endpointTypeOf(olds.regions) !== endpointTypeOf(news.regions) ||
  !deepEqual(normalizeRegions(olds.regions), normalizeRegions(news.regions));

/**
 * Endpoint names allow letters, digits, `-` and `_`, up to 64 characters,
 * and can't begin or end with `-` or `_`.
 */
export const toEndpointName = (id: string) =>
  id
    .replaceAll(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);

/** The `endpointConfig` for `CreateWebFunction` (the built-in endpoint). */
export const createEndpointConfig = (spec: WebFunctionEndpointSpec): LambdaWeb.EndpointConfig => {
  const endpointType = endpointTypeOf(spec.regions);
  return {
    endpointName: spec.endpointName,
    description: spec.description,
    endpointType,
    ...(endpointType === "MultiRegion" ? { regions: normalizeRegions(spec.regions) } : {}),
    authType: spec.authType,
    autoDeploymentMode: "Disabled",
    ...(spec.maxEnvironments === undefined
      ? {}
      : { scalingConfig: { maxEnvironments: spec.maxEnvironments } }),
    ...(spec.rateLimit === undefined ? {} : { throttleConfig: { rateLimit: spec.rateLimit } }),
  };
};

export const getEndpoint = (functionName: string, endpointName: string) =>
  LambdaWeb.getWebFunctionEndpoint({ functionName, endpointName }).pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
  );

/** The revision receiving all of an endpoint's traffic. */
export const activeRevisionId = (endpoint: {
  revisionWeights: readonly { revisionId: string; weight: number }[];
}) =>
  endpoint.revisionWeights.find((w) => w.weight === 100)?.revisionId ??
  endpoint.revisionWeights[0]?.revisionId ??
  "";

/** Settings `UpdateWebFunctionEndpoint` changes in place. */
const desiredSettings = (spec: WebFunctionEndpointSpec, revisionId: string) => ({
  description: spec.description ?? "",
  authType: spec.authType,
  autoDeploymentMode: "Disabled" as const,
  revisionWeights: [{ revisionId, weight: 100 }],
  // `{}` clears a previously set value.
  scalingConfig:
    spec.maxEnvironments === undefined ? {} : { maxEnvironments: spec.maxEnvironments },
  throttleConfig: spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit },
});

const settingsMatch = (
  observed: LambdaWeb.GetWebFunctionEndpointResponse,
  desired: ReturnType<typeof desiredSettings>,
) =>
  (observed.description ?? "") === desired.description &&
  observed.authType === desired.authType &&
  observed.autoDeploymentMode === desired.autoDeploymentMode &&
  deepEqual(
    observed.revisionWeights.filter((w) => w.weight > 0),
    desired.revisionWeights,
  ) &&
  observed.scalingConfig?.maxEnvironments === desired.scalingConfig.maxEnvironments &&
  observed.throttleConfig?.rateLimit === desired.throttleConfig.rateLimit;

/** Another update to the same function or endpoint is in progress. */
const retryConflict = <A, E extends { _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.retry({
      while: (e) => e._tag === "ConflictException",
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

const waitForSettled = (
  functionName: string,
  endpointName: string,
  session: { note: (note: string) => Effect.Effect<void> },
) =>
  Effect.gen(function* () {
    const endpoint = yield* getEndpoint(functionName, endpointName);
    if (endpoint?.state === "Failed" || endpoint?.updateStatus === "Failed") {
      return yield* new WebFunctionFailed({
        functionName,
        resource: `endpoint ${endpointName}`,
        reason: endpoint.updateStatusReason ?? endpoint.stateReason,
      });
    }
    if (endpoint?.state === "Active" && endpoint.updateStatus !== "InProgress") {
      return endpoint;
    }
    return yield* new WebFunctionNotReady({
      functionName,
      resource: `endpoint ${endpointName}`,
      state: endpoint?.updateStatus === "InProgress" ? "updating" : (endpoint?.state ?? "missing"),
    });
  }).pipe(
    Effect.tapError((e) =>
      e._tag === "WebFunctionNotReady" ? session.note(e.message) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "WebFunctionNotReady",
      schedule: Schedule.spaced("2 seconds"),
      times: 90,
    }),
  );

/** Delete an endpoint and wait until it is gone. Idempotent. */
export const deleteEndpoint = (functionName: string, endpointName: string) =>
  Effect.gen(function* () {
    yield* LambdaWeb.deleteWebFunctionEndpoint({ functionName, endpointName }).pipe(
      retryConflict,
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
    yield* Effect.gen(function* () {
      const endpoint = yield* getEndpoint(functionName, endpointName);
      if (endpoint === undefined) return;
      return yield* new WebFunctionNotReady({
        functionName,
        resource: `endpoint ${endpointName}`,
        state: endpoint.state,
      });
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "WebFunctionNotReady",
        schedule: Schedule.spaced("2 seconds"),
        times: 45,
      }),
    );
  });

/**
 * Converge one endpoint on `spec`, routing all traffic to `revisionId`:
 * observe it, recreate it when its type or Regions disagree, create it when
 * missing, update the in-place settings that differ, and wait until it
 * settles.
 */
export const syncEndpoint = Effect.fn(function* ({
  functionName,
  spec,
  revisionId,
  session,
}: {
  functionName: string;
  spec: WebFunctionEndpointSpec;
  revisionId: string;
  session: { note: (note: string) => Effect.Effect<void> };
}) {
  const endpointType = endpointTypeOf(spec.regions);
  // Lambda adds the home Region to a MultiRegion endpoint itself.
  const { region: homeRegion } = yield* AWSEnvironment.current;
  const remoteRegions = (regions: readonly string[] | undefined) =>
    normalizeRegions(regions?.filter((r) => r !== homeRegion));

  let endpoint = yield* getEndpoint(functionName, spec.endpointName);
  if (
    endpoint !== undefined &&
    (endpoint.endpointType !== endpointType ||
      (endpointType === "MultiRegion" &&
        !deepEqual(remoteRegions(endpoint.regions), remoteRegions(spec.regions))))
  ) {
    yield* deleteEndpoint(functionName, spec.endpointName);
    endpoint = undefined;
  }

  const settings = desiredSettings(spec, revisionId);
  if (endpoint === undefined) {
    yield* LambdaWeb.createWebFunctionEndpoint({
      functionName,
      ...createEndpointConfig(spec),
      revisionWeights: settings.revisionWeights,
    }).pipe(retryConflict);
  } else if (!settingsMatch(endpoint, settings)) {
    yield* LambdaWeb.updateWebFunctionEndpoint({
      functionName,
      endpointName: spec.endpointName,
      ...settings,
    }).pipe(retryConflict);
  }
  return yield* waitForSettled(functionName, spec.endpointName, session);
});
