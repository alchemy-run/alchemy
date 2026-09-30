import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ParametersVersion } from "./ParametersVersion.ts";
import { RenderParameterVersion } from "./RenderParameterVersion.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link RenderParameterVersion}.
 *
 * @layer
 * @provides GCP.Parametermanager.RenderParameterVersion
 */
export const RenderParameterVersionHttp = Layer.effect(
  RenderParameterVersion,
  Effect.gen(function* () {
    const render =
      yield* parametermanager.renderProjectsLocationsParametersVersions;
    return Effect.fn(function* (version: ParametersVersion) {
      yield* bindGcpHost({
        tag: "GCP.Parametermanager.RenderParameterVersion",
        resource: version,
        // Parameter Manager has no resource-level IAM.
        iam: [{ role: "roles/parametermanager.parameterAccessor" }],
      });
      const name = yield* version.name;
      return Effect.fn(
        `GCP.Parametermanager.RenderParameterVersion(${version.LogicalId})`,
      )(function* () {
        return yield* render({ name: yield* name });
      });
    });
  }),
);
