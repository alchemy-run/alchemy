import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { VolumeSandbox } from "./box.ts";

/** A plain container: the Durable Object only execs in it. */
export default Cloudflare.Containers.Sandbox(
  VolumeSandbox,
  {
    main: import.meta.url,
    runtime: "node",
    image: "node:22-bookworm-slim",
    sizes: { small: "standard-1" },
  },
  Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
);
