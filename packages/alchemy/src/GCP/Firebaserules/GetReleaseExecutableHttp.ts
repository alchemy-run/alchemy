import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GetReleaseExecutable,
  type GetReleaseExecutableRequest,
} from "./GetReleaseExecutable.ts";
import type { Release } from "./Release.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link GetReleaseExecutable}.
 *
 * @layer
 * @provides GCP.Firebaserules.GetReleaseExecutable
 */
export const GetReleaseExecutableHttp = Layer.effect(
  GetReleaseExecutable,
  Effect.gen(function* () {
    const getExecutableProjectsReleases =
      yield* firebaserules.getExecutableProjectsReleases;
    return Effect.fn(function* (release: Release) {
      yield* bindGcpHost({
        tag: "GCP.Firebaserules.GetReleaseExecutable",
        resource: release,
        // firebaserules.releases.getExecutable is only in firebaserules.admin;
        // no narrower predefined role exists. No resource-level IAM.
        iam: [{ role: "roles/firebaserules.admin" }],
      });
      const name = yield* release.name;
      return Effect.fn(
        `GCP.Firebaserules.GetReleaseExecutable(${release.LogicalId})`,
      )(function* (request: GetReleaseExecutableRequest = {}) {
        return yield* getExecutableProjectsReleases({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
