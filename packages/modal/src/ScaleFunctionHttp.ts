import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionBinding } from "./FunctionTarget.ts";
import { operations } from "./internal.ts";
import type { FunctionTarget } from "./InvokeFunction.ts";
import { ScaleFunction, type FunctionScaler } from "./ScaleFunction.ts";
import type { Server } from "./Server.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const ScaleFunctionOps = operations({
  schedulingParams: functions.functionGetSchedulingParams,
  updateSchedulingParams: functions.functionUpdateSchedulingParams,
});

export type ScaleFunctionOps = Effect.Success<typeof ScaleFunctionOps>;

/**
 * {@link ScaleFunction} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the function's environment.
 *
 * @layer
 * @product Function
 * @provides Modal.ScaleFunction
 */
export const ScaleFunctionHttp = Layer.effect(
  ScaleFunction,
  makeFunctionBinding({
    tag: "Modal.ScaleFunction",
    operations: ScaleFunctionOps,
    role: "contributor",
    make: ({ functionId }, ops, _target: FunctionTarget | Server) =>
      Effect.succeed({
        autoscaler: () =>
          Effect.flatMap(functionId, (id) => ops.schedulingParams({ functionId: id })).pipe(
            Effect.map((response) => response.autoscalerConfiguration?.settings),
          ),
        update: (settings) =>
          Effect.flatMap(functionId, (id) =>
            ops.updateSchedulingParams({
              functionId: id,
              settings: {
                minContainers: settings.minContainers,
                maxContainers: settings.maxContainers,
                bufferContainers: settings.bufferContainers,
                scaleupWindow: settings.scaleupWindow,
                scaledownWindow: settings.scaledownWindow,
                targetConcurrencyFloat: settings.targetConcurrency,
              },
            }),
          ).pipe(Effect.map((response) => response.currentSettings)),
      } satisfies FunctionScaler),
  }),
);
