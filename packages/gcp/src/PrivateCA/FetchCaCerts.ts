import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { CaPool } from "./CaPool.ts";

export interface FetchCaCertsRequest {
  /**
   * Optional UUID used to make the fetch idempotent for at least 60
   * minutes.
   */
  requestId?: string;
}

/**
 * Runtime binding for Certificate Authority Service `caPools.fetchCaCerts`.
 *
 * Bind this operation to a {@link CaPool} in a Function/Action init phase.
 * Provide {@link FetchCaCertsHttp}. Returns PEM CA certificate chains for
 * authorities in the ENABLED, DISABLED, or STAGED states.
 *
 * ### Fetching CA Certificates
 * **Example:** Fetch the pool's trust anchors
 * ```typescript
 * const fetchCaCerts = yield* GCP.PrivateCA.FetchCaCerts(pool);
 * const { caCerts } = yield* fetchCaCerts();
 * ```
 *
 * @binding
 * @category PrivateCA
 */
export interface FetchCaCerts extends Binding.Service<
  FetchCaCerts,
  "GCP.PrivateCA.FetchCaCerts",
  (
    pool: CaPool,
  ) => Effect.Effect<
    (
      request?: FetchCaCertsRequest,
    ) => Effect.Effect<
      privateca.FetchCaCertsResponse,
      privateca.FetchCaCertsProjectsLocationsCaPoolsError,
      RuntimeContext
    >
  >
> {}

export const FetchCaCerts = Binding.Service<FetchCaCerts>("GCP.PrivateCA.FetchCaCerts");

/**
 * HTTP implementation of {@link FetchCaCerts}.
 *
 * @layer
 * @provides GCP.PrivateCA.FetchCaCerts
 */
export const FetchCaCertsHttp = Layer.effect(
  FetchCaCerts,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const fetchCaCertsProjectsLocationsCaPools = yield* GCPBindings.withCredentials(
      privateca.fetchCaCertsProjectsLocationsCaPools,
    );
    return Effect.fn(function* <P extends CaPool>(pool: P) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.PrivateCA.FetchCaCerts(${pool})`({
          iam: [
            grantFor({ role: "roles/privateca.poolReader", on: "privateca.caPool" }, pool.name),
          ],
        });
      }
      const name = yield* pool.name;
      return Effect.fn(`GCP.PrivateCA.FetchCaCerts(${pool.LogicalId})`)(function* (
        request?: FetchCaCertsRequest,
      ) {
        return yield* fetchCaCertsProjectsLocationsCaPools({
          caPool: yield* name,
          body: request?.requestId !== undefined ? { requestId: request.requestId } : {},
        });
      });
    });
  }),
);
