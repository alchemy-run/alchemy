/** The HTTP front of the GCP conformance suite: a public Cloud Run service calling the counter. */
import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter } from "../counter-declaration.ts";

export default class Front extends GCP.Run.Service<Front>()(
  "RivetGcpFront",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }),
) {}
