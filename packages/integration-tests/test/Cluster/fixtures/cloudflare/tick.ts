/** A cron declared inline: the class is its implementation. */
import * as Cluster from "@alchemy.run/effect-cluster";
import { TICK_SCHEDULE, tick } from "../scheduled/tick.ts";
import { Default } from "./cluster.ts";

export default class Tick extends Cluster.Cron<Tick>()(
  "Tick",
  { main: import.meta.url, cron: TICK_SCHEDULE },
  tick(Default),
) {}
