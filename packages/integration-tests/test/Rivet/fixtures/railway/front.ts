/** The HTTP front of the Railway conformance suite: a Railway Service calling the counter. */
import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter } from "../counter-declaration.ts";

export const FrontProject = Railway.Project("RivetRailwayFrontProject");

export default class Front extends Railway.Service<Front>()(
  "RivetRailwayFront",
  { project: FrontProject, main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }),
) {}
