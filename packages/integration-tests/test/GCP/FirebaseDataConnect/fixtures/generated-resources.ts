import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { schemaSource, unlinkedDatasources } from "../common.ts";
import { App } from "./bindings-host.ts";

/** Resources the generated FirebaseDataConnect bindings bind: the suite's own fixtures. */
export { App, Queries } from "./bindings-host.ts";

export const ProbeSchema = Effect.gen(function* () {
  const service = yield* App;
  return yield* GCP.FirebaseDataConnect.ServicesSchema("ProbeSchema", {
    service: service.name,
    source: schemaSource(),
    datasources: unlinkedDatasources,
  });
});
