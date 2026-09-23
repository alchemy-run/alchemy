import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Link, LinkNotFound } from "./Link.ts";

export class LinksGroup extends HttpApiGroup.make("links")
  .add(
    HttpApiEndpoint.post("create", "/links", {
      payload: Schema.Struct({ url: Schema.String }),
      success: Link,
    }),
  )
  .add(HttpApiEndpoint.get("list", "/links", { success: Schema.Array(Link) }))
  .add(
    HttpApiEndpoint.get("get", "/links/:code", {
      params: Schema.Struct({ code: Schema.String }),
      success: Link,
      error: LinkNotFound,
    }),
  ) {}

/** One value: served by the Worker, called by the dashboard and the tests. */
export class ShortyApi extends HttpApi.make("ShortyApi").add(LinksGroup) {}
