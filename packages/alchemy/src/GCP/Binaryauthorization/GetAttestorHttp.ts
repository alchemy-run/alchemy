import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Attestor } from "./Attestor.ts";
import { GetAttestor, type GetAttestorRequest } from "./GetAttestor.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetAttestor}.
 *
 * @layer
 * @provides GCP.Binaryauthorization.GetAttestor
 */
export const GetAttestorHttp = Layer.effect(
  GetAttestor,
  Effect.gen(function* () {
    const getAttestor = yield* binaryauthorization.getProjectsAttestors;
    return Effect.fn(function* (attestor: Attestor) {
      yield* bindGcpHost({
        tag: "GCP.Binaryauthorization.GetAttestor",
        resource: attestor,
        iam: [{ role: defaultRoleFor("GCP.Binaryauthorization.GetAttestor") }],
      });
      const name = yield* attestor.name;
      return Effect.fn(
        `GCP.Binaryauthorization.GetAttestor(${attestor.LogicalId})`,
      )(function* (request?: GetAttestorRequest) {
        const attestorName = yield* name;
        return yield* getAttestor({
          ...request,
          name: attestorName,
        });
      });
    });
  }),
);
