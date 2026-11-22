/** The Fly suite's front: a public Fly Service calling everything through the gateways. */
import * as Fly from "@alchemy.run/fly";
import { frontApp } from "../app.ts";
import { Tally } from "./tally.ts";

export default class Front extends Fly.Service<Front>()(
  "ClusterFlyFront",
  { main: import.meta.url },
  frontApp(Tally),
) {}
