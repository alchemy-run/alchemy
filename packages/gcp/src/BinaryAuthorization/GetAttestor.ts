import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Attestor } from "./Attestor.ts";

export interface GetAttestorRequest extends Omit<
  binaryauthorization.GetProjectsAttestorsRequest,
  "name"
> {}

/**
 * Runtime binding for Binary Authorization `attestors.get`.
 *
 * Bind this operation to an {@link Attestor} in a Function/Action init
 * phase. Provide {@link GetAttestorHttp}.
 *
 * ### Reading an Attestor
 * **Example:** Get the bound attestor
 * ```typescript
 * const getAttestor = yield* GCP.BinaryAuthorization.GetAttestor(attestor);
 * const live = yield* getAttestor();
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface GetAttestor extends Binding.Service<
  GetAttestor,
  "GCP.BinaryAuthorization.GetAttestor",
  (
    attestor: Attestor,
  ) => Effect.Effect<
    (
      request?: GetAttestorRequest,
    ) => Effect.Effect<
      binaryauthorization.Attestor,
      binaryauthorization.GetProjectsAttestorsError,
      RuntimeContext
    >
  >
> {}

export const GetAttestor = Binding.Service<GetAttestor>("GCP.BinaryAuthorization.GetAttestor");

/**
 * HTTP implementation of {@link GetAttestor}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.GetAttestor
 */
export const GetAttestorHttp = Layer.effect(
  GetAttestor,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getAttestor = yield* GCPBindings.withCredentials(
      binaryauthorization.getProjectsAttestors,
    );
    return Effect.fn(function* (attestor: Attestor) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BinaryAuthorization.GetAttestor(${attestor})`({
          iam: [
            grantFor(
              {
                role: "roles/binaryauthorization.attestorsViewer",
                on: "binaryauthorization.attestor",
              },
              attestor.name,
            ),
          ],
        });
      }
      const name = yield* attestor.name;
      return Effect.fn(`GCP.BinaryAuthorization.GetAttestor(${attestor.LogicalId})`)(function* (
        request?: GetAttestorRequest,
      ) {
        const attestorName = yield* name;
        return yield* getAttestor({
          ...request,
          name: attestorName,
        });
      });
    });
  }),
);
