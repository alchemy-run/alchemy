/** The HTTP front of the AWS conformance suite: a Lambda calling the counter through the gateway. */
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter } from "../counter-declaration.ts";

export default class Front extends Lambda.Function<Front>()(
  "RivetAwsFront",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }),
) {}
