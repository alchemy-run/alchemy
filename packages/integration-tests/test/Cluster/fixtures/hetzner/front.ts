/** The Hetzner suite's front: a Hetzner Service calling everything through the gateways. */
import * as Hetzner from "@alchemy.run/hetzner";
import { frontApp } from "../app.ts";
import { Tally } from "./tally.ts";

export const FrontServer = Hetzner.Server("ClusterHetznerFrontServer", {
  serverType: "cx23",
  image: "ubuntu-24.04",
  location: "nbg1",
  enableIpv6: false,
});

export default class Front extends Hetzner.Service<Front>()(
  "ClusterHetznerFront",
  { server: FrontServer, main: import.meta.url },
  frontApp(Tally),
) {}
