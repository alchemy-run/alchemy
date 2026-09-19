import type * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdminReservation } from "./AdminReservation.ts";

export interface GetReservationRequest extends Omit<
  pubsublite.GetAdminProjectsLocationsReservationsRequest,
  "name"
> {}

/**
 * Runtime binding for Pub/Sub Lite `reservations.get`.
 *
 * Bind this operation to an {@link AdminReservation} in a Function/Action
 * init phase. Provide {@link GetReservationHttp}.
 *
 * ### Observing Reservations
 * **Example:** Read the bound reservation
 * ```typescript
 * const getReservation = yield* GCP.Pubsublite.GetReservation(capacity);
 * const live = yield* getReservation();
 * ```
 *
 * @binding
 * @product GCP
 * @category Pubsublite
 */
export interface GetReservation extends Binding.Service<
  GetReservation,
  "GCP.Pubsublite.GetReservation",
  (
    reservation: AdminReservation,
  ) => Effect.Effect<
    (
      request?: GetReservationRequest,
    ) => Effect.Effect<
      pubsublite.Reservation,
      pubsublite.GetAdminProjectsLocationsReservationsError,
      RuntimeContext
    >
  >
> {}

export const GetReservation = Binding.Service<GetReservation>(
  "GCP.Pubsublite.GetReservation",
);
