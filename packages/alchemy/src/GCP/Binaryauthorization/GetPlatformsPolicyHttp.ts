import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  GetPlatformsPolicy,
  type GetPlatformsPolicyRequest,
} from "./GetPlatformsPolicy.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetPlatformsPolicy}.
 *
 * @layer
 * @provides GCP.Binaryauthorization.GetPlatformsPolicy
 */
export const GetPlatformsPolicyHttp = Layer.effect(
  GetPlatformsPolicy,
  Effect.gen(function* () {
    const getPolicy = yield* binaryauthorization.getProjectsPlatformsPolicies;
    return Effect.fn(function* (policy: PlatformsPolicy) {
      yield* bindGcpHost({
        tag: "GCP.Binaryauthorization.GetPlatformsPolicy",
        resource: policy,
        iam: [
          {
            role: defaultRoleFor("GCP.Binaryauthorization.GetPlatformsPolicy"),
          },
        ],
      });
      const name = yield* policy.name;
      return Effect.fn(
        `GCP.Binaryauthorization.GetPlatformsPolicy(${policy.LogicalId})`,
      )(function* (request?: GetPlatformsPolicyRequest) {
        return yield* getPolicy({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
