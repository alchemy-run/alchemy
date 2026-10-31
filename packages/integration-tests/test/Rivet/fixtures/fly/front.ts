/** The HTTP front of the Fly conformance suite: a public Fly Service calling the counter. */
import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter } from "../counter-declaration.ts";

export default class Front extends Fly.Service<Front>()(
  "RivetFlyFront",
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }),
) {}
