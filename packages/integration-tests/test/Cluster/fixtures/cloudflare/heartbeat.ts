/** A singleton declared inline: the class is its implementation. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { heartbeat } from "../scheduled/heartbeat.ts";
import { Default } from "./cluster.ts";

export default class Heartbeat extends Cluster.Singleton<Heartbeat>()(
  "Heartbeat",
  { main: import.meta.url },
  heartbeat(Default),
) {}
