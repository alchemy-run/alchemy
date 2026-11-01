/** The HTTP front of the Hetzner conformance suite: a Hetzner Service calling the counter. */
import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter } from "../counter-declaration.ts";

export const FrontServer = Hetzner.Server("RivetHetznerFrontServer", {
  serverType: "cx23",
  image: "ubuntu-24.04",
  location: "nbg1",
});

export default class Front extends Hetzner.Service<Front>()(
  "RivetHetznerFront",
  { server: FrontServer, main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }),
) {}
