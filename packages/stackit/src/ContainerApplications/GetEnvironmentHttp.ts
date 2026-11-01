import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { GetEnvironment } from "./GetEnvironment.ts";

/**
 * HTTP implementation of {@link GetEnvironment}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.GetEnvironment
 */
export const GetEnvironmentHttp = Layer.effect(
  GetEnvironment,
  makeEnvironmentHttpBinding({
    tag: "Stackit.ContainerApplications.GetEnvironment",
    permissions: ["sca.environment.get"],
    operation: sca.getEnvironment,
  }),
);
