/** The HTTP front of the Hetzner conformance suite: a Hetzner Service calling the counter and a stream. */
import * as Hetzner from "@alchemy.run/hetzner";
import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { durableStreamFront } from "../durable-stream-front.ts";
import { Services } from "./cluster.ts";

export const FrontServer = Hetzner.Server("RivetHetznerFrontServer", {
  serverType: "cx23",
  image: "ubuntu-24.04",
  location: "nbg1",
  // The suite reaches it over IPv4; skipping IPv6 keeps the project's
  // shared primary-IP quota for the suite's other Servers.
  enableIpv6: false,
});

export default class Front extends Hetzner.Service<Front>()(
  "RivetHetznerFront",
  { server: FrontServer, main: import.meta.url },
  durableStreamFront.pipe(Effect.provide(Layer.mergeAll(Services, StreamFormat.Json))),
) {}
