/** The GCP suite's front: a public Cloud Run service calling everything through the gateways. */
import * as GCP from "@alchemy.run/gcp";
import { frontApp } from "../app.ts";
import { Tally } from "./tally.ts";

export default class Front extends GCP.Run.Service<Front>()(
  "ClusterGcpFront",
  { main: import.meta.url, invokerIamDisabled: true },
  frontApp(Tally),
) {}
