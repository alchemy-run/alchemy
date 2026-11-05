import * as rum from "@distilled.cloud/aws/rum";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AppMonitor } from "./AppMonitor.ts";
import { BindRumAppMonitorPolicy } from "./BindingHttp.ts";

export interface PutRumEventsRequest extends Omit<
  rum.PutRumEventsRequest,
  "Id" | "AppMonitorDetails"
> {
  /**
   * Details of the app monitor sending the events. Defaults to the bound
   * monitor's name and id.
   */
  AppMonitorDetails?: rum.AppMonitorDetails;
}

/**
 * Runtime binding for `rum:PutRumEvents` — send a batch of telemetry events
 * from one user session to the bound {@link AppMonitor}'s data plane (the
 * same operation the RUM web client uses); the monitor id and details are
 * injected automatically.
 *
 * Provide `RUM.PutRumEventsHttp` on the hosting Lambda Function to satisfy
 * the requirement.
 * ### Sending RUM Events
 * **Example:** Send a Session's Events Server-Side
 * ```typescript
 * // init — grants rum:PutRumEvents on the monitor
 * const putRumEvents = yield* AWS.RUM.PutRumEvents(monitor);
 *
 * // runtime
 * yield* putRumEvents({
 *   BatchId: crypto.randomUUID(),
 *   UserDetails: { userId, sessionId },
 *   RumEvents: [
 *     {
 *       id: crypto.randomUUID(),
 *       timestamp: new Date(),
 *       type: "com.amazon.rum.session_start_event",
 *       details: "{}",
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface PutRumEvents extends Binding.Service<
  PutRumEvents,
  "AWS.RUM.PutRumEvents",
  (
    monitor: AppMonitor,
  ) => Effect.Effect<
    (request: PutRumEventsRequest) => Effect.Effect<rum.PutRumEventsResponse, rum.PutRumEventsError>
  >
> {}

export const PutRumEvents = Binding.Service<PutRumEvents>("AWS.RUM.PutRumEvents");

/**
 * Bespoke (not `makeRumAppMonitorHttpBinding`): `PutRumEvents` addresses the
 * data-plane endpoint by monitor *id* (not name) and defaults the
 * `AppMonitorDetails` envelope from the bound monitor.
 */
export const PutRumEventsHttp = Layer.effect(
  PutRumEvents,
  Effect.gen(function* () {
    const bindRumAppMonitorPolicy = yield* BindRumAppMonitorPolicy;
    const op = yield* AWSBindings.withCredentials(rum.putRumEvents);

    return Effect.fn(function* (monitor: AppMonitor) {
      const monitorId = yield* monitor.appMonitorId;
      const monitorName = yield* monitor.appMonitorName;
      yield* bindRumAppMonitorPolicy({
        tag: "AWS.RUM.PutRumEvents",
        monitor,
        actions: ["rum:PutRumEvents"],
      });
      return Effect.fn(`AWS.RUM.PutRumEvents(${monitor.LogicalId})`)(function* (
        request: PutRumEventsRequest,
      ) {
        const Id = yield* monitorId;
        return yield* op({
          ...request,
          Id,
          AppMonitorDetails: request.AppMonitorDetails ?? {
            name: yield* monitorName,
            id: Id,
          },
        });
      });
    });
  }),
);
