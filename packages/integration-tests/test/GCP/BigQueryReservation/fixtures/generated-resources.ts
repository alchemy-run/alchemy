import * as GCP from "@alchemy.run/gcp";

/** BigQueryReservation resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeReservation = GCP.BigQueryReservation.Reservation("ProbeReservation", {
  location: "us-central1",
  edition: "ENTERPRISE",
  slotCapacity: "0",
});
export const ProbeReservationGroup = GCP.BigQueryReservation.ReservationGroup(
  "ProbeReservationGroup",
  {
    location: "us-central1",
  },
);
