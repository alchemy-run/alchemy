import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  EvaluateGkePolicy,
  type EvaluateGkePolicyRequest,
} from "./EvaluateGkePolicy.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link EvaluateGkePolicy}.
 *
 * @layer
 * @provides GCP.Binaryauthorization.EvaluateGkePolicy
 */
export const EvaluateGkePolicyHttp = Layer.effect(
  EvaluateGkePolicy,
  Effect.gen(function* () {
    const evaluate =
      yield* binaryauthorization.evaluateProjectsPlatformsGkePolicies;
    return Effect.fn(function* (policy: PlatformsPolicy) {
      yield* bindGcpHost({
        tag: "GCP.Binaryauthorization.EvaluateGkePolicy",
        resource: policy,
        iam: [
          { role: defaultRoleFor("GCP.Binaryauthorization.EvaluateGkePolicy") },
        ],
      });
      const name = yield* policy.name;
      return Effect.fn(
        `GCP.Binaryauthorization.EvaluateGkePolicy(${policy.LogicalId})`,
      )(function* (request: EvaluateGkePolicyRequest) {
        return yield* evaluate({
          name: yield* name,
          body: request,
        });
      });
    });
  }),
);
