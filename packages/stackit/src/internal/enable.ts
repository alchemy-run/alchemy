import * as serviceEnablement from "@distilled.cloud/stackit/service_enablement";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { waitFor } from "./wait.ts";

/** A service's enablement state in a project (Service Enablement API). */
export type ServiceState = serviceEnablement.ServiceStatusState;

export interface EnsureServiceEnabledInput {
  /** Project to enable the service in. */
  readonly projectId: string;
  /** Region of the enablement (`eu01`, ...). */
  readonly region: string;
  /** STACKIT service id, e.g. `cloud.stackit.ske`. */
  readonly serviceId: string;
  /**
   * How long to wait for `ENABLED` (and, first, for an in-flight
   * `DISABLING` to settle).
   * @default "5 minutes"
   */
  readonly timeout?: Duration.Input;
}

export interface EnsureServiceEnabledResult {
  /** The final, `ENABLED` service status. */
  readonly status: serviceEnablement.ServiceStatus;
  /** `true` when this call enabled the service; `false` when it already was. */
  readonly enabledNow: boolean;
}

/** Read a service's enablement status (`NotFound` = unknown service id, propagated). */
export const getServiceStatus = (input: {
  readonly projectId: string;
  readonly region: string;
  readonly serviceId: string;
}) =>
  serviceEnablement.getServiceStatusRegional({
    projectId: input.projectId,
    region: input.region,
    serviceId: input.serviceId,
  });

const describe = (input: EnsureServiceEnabledInput) =>
  `STACKIT service ${input.serviceId} in project ${input.projectId} (${input.region})`;

const stateLabel = (status: serviceEnablement.ServiceStatus) => {
  const error = status.error;
  return error?.reason === undefined
    ? status.state
    : `${status.state ?? "UNKNOWN"} (last ${error.action ?? "action"} error: ${error.reason})`;
};

/**
 * Idempotently enable a STACKIT service for a project and wait until it is
 * `ENABLED`. Call it inside `reconcile` before the first API call of a
 * service that requires per-project enablement; it costs one GET when the
 * service is already enabled.
 *
 * Flow: observe the status; if `DISABLING`, wait for it to settle; if not
 * `ENABLED`/`ENABLING`, call enable; then wait for `ENABLED`. Enabling also
 * enables the service's hard dependencies (STACKIT does that server-side).
 *
 * Fails with the operation's typed errors (`Forbidden` when the caller may
 * not enable services, `NotFound` for an unknown service id), or with
 * `Stackit.WaitTimeout` / `Stackit.ResourceFailed` from the shared waiter.
 */
export const ensureServiceEnabled = Effect.fn("Stackit.ensureServiceEnabled")(function* (
  input: EnsureServiceEnabledInput,
) {
  const timeout = input.timeout ?? "5 minutes";
  const resource = describe(input);
  // A 404 on the status read may mean "never enabled" rather than "unknown
  // id"; the enable call below is the authority and propagates `NotFound`
  // for an unknown service id.
  const read = getServiceStatus(input).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

  let status = yield* read;
  if (status?.state === "ENABLED") {
    return { status, enabledNow: false } satisfies EnsureServiceEnabledResult;
  }

  if (status?.state === "DISABLING") {
    status = yield* waitFor({
      resource,
      read,
      ready: (s) => s?.state !== "DISABLING",
      state: (s) => (s === undefined ? "UNKNOWN" : stateLabel(s)),
      timeout,
    });
  }

  let enabledNow = false;
  if (status?.state !== "ENABLED" && status?.state !== "ENABLING") {
    yield* serviceEnablement.enableServiceRegional({
      projectId: input.projectId,
      region: input.region,
      serviceId: input.serviceId,
    });
    enabledNow = true;
  }

  // An enable that fails server-side settles back to DISABLED with
  // `error.action === "ENABLE"`. Only trust that once ENABLING was seen, so
  // a stale error from an earlier attempt can't fail this one.
  let sawEnabling = status?.state === "ENABLING";
  const final = yield* waitFor({
    resource,
    read,
    ready: (s) => s?.state === "ENABLED",
    failed: (s) => {
      if (s?.state === "ENABLING") sawEnabling = true;
      return sawEnabling && s?.state === "DISABLED" && s.error?.action === "ENABLE"
        ? (s.error.reason ?? "enable failed")
        : undefined;
    },
    state: (s) => (s === undefined ? "UNKNOWN" : stateLabel(s)),
    timeout,
  });
  // `ready` guarantees a defined, ENABLED status.
  const enabled: serviceEnablement.ServiceStatus = final ?? { state: "ENABLED" };
  return { status: enabled, enabledNow } satisfies EnsureServiceEnabledResult;
});

/**
 * Disable a STACKIT service for a project and wait until it is `DISABLED`.
 * Idempotent: an already-disabled service (or an unknown service id) is a
 * no-op. Only call it for services the caller itself enabled — disabling is
 * project-wide.
 */
export const disableService = Effect.fn("Stackit.disableService")(function* (
  input: EnsureServiceEnabledInput,
) {
  const timeout = input.timeout ?? "5 minutes";
  const resource = describe(input);
  const read = getServiceStatus(input);
  const status = yield* read.pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  if (status === undefined || status.state === "DISABLED") return;
  if (status.state !== "DISABLING") {
    yield* serviceEnablement
      .disableServiceRegional({
        projectId: input.projectId,
        region: input.region,
        serviceId: input.serviceId,
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }
  let sawDisabling = status.state === "DISABLING";
  yield* waitFor({
    resource,
    read: read.pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
    ready: (s) => s === undefined || s.state === "DISABLED",
    failed: (s) => {
      if (s?.state === "DISABLING") sawDisabling = true;
      return sawDisabling && s?.state === "ENABLED" && s.error?.action === "DISABLE"
        ? (s.error.reason ?? "disable failed")
        : undefined;
    },
    state: (s) => (s === undefined ? "gone" : stateLabel(s)),
    timeout,
  });
});
