// The shared HttpApi schema — the ONLY module the browser imports to talk
// to the backend. It is pure schema (no backend imports, no alchemy
// imports), so the client bundle carries zero server bytes and every
// request/response is validated on both sides of the wire.
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export class VisitCount extends Schema.Class<VisitCount>("VisitCount")({
  count: Schema.Number,
}) {}

export class Processed extends Schema.Class<Processed>("Processed")({
  count: Schema.Number,
  last: Schema.NullOr(Schema.String),
}) {}

// Paths carry the full /api prefix: the site's `server.routes` (default
// ["/api/*"]) is the URL space the CloudFront edge router forwards to the
// backend Lambda, and the Lambda sees the unmodified path.
export class SiteGroup extends HttpApiGroup.make("Site")
  .add(
    HttpApiEndpoint.get("visits", "/api/visits", {
      success: VisitCount,
    }),
  )
  .add(
    HttpApiEndpoint.post("bump", "/api/visits/bump", {
      success: VisitCount,
    }),
  )
  .add(
    HttpApiEndpoint.post("enqueue", "/api/queue", {
      // Schema-validated: a missing or empty `message` is answered with a
      // 400 before any handler code runs.
      payload: Schema.Struct({ message: Schema.NonEmptyString }),
      success: Schema.Struct({ enqueued: Schema.Boolean }),
    }),
  )
  .add(
    HttpApiEndpoint.get("processed", "/api/queue/processed", {
      success: Processed,
    }),
  ) {}

export class SiteApi extends HttpApi.make("SiteApi").add(SiteGroup) {}
