/**
 * The Railway suite's front: a public Railway Service in the cluster's
 * environment, calling everything through the gateways on the private network.
 */
import * as Railway from "@alchemy.run/railway";
import { Partition, Site } from "../../../Railway/fixtures/suite-env.ts";
import { frontApp } from "../app.ts";
import { Tally } from "./tally.ts";

export default class Front extends Railway.Service<Front>()(
  "ClusterRailwayFront",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: 3000,
    // Probe `/ready` instead of Alchemy's default `/health`.
    healthcheck: "/ready",
  },
  frontApp(Tally),
) {}
