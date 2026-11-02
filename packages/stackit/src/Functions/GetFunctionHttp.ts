import * as functions from "@distilled.cloud/stackit/functions";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GetFunction } from "./GetFunction.ts";

/**
 * HTTP implementation of {@link GetFunction}.
 *
 * @layer
 * @provides Stackit.Functions.GetFunction
 */
export const GetFunctionHttp = Layer.effect(
  GetFunction,
  makeFunctionHttpBinding({
    tag: "Stackit.Functions.GetFunction",
    permissions: ["functions.function.get"],
    operation: functions.getFunction,
  }),
);
