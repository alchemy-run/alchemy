import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GetParameter } from "./GetParameter.ts";
import type { Parameter } from "./Parameter.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link GetParameter}.
 *
 * @layer
 * @provides GCP.Parametermanager.GetParameter
 */
export const GetParameterHttp = Layer.effect(
  GetParameter,
  Effect.gen(function* () {
    const getParameter = yield* parametermanager.getProjectsLocationsParameters;
    return Effect.fn(function* (parameter: Parameter) {
      yield* bindGcpHost({
        tag: "GCP.Parametermanager.GetParameter",
        resource: parameter,
        // Parameter Manager has no resource-level IAM.
        iam: [{ role: "roles/parametermanager.parameterViewer" }],
      });
      const name = yield* parameter.name;
      return Effect.fn(
        `GCP.Parametermanager.GetParameter(${parameter.LogicalId})`,
      )(function* () {
        return yield* getParameter({ name: yield* name });
      });
    });
  }),
);
