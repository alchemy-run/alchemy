/**
 * The front of the Workflows conformance suite: a Docker service on the
 * control plane's network that starts and reads runs through the gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { app } from "../../Workflows/conformance/app.ts";
import { WORKFLOW_FRONT_PORT, WorkflowControlPlane } from "./workflow-cluster.ts";
import { WorkflowsRivetLive } from "./workflow-live.ts";

export default class WorkflowFront extends Docker.Service<WorkflowFront>()(
  "RivetWorkflowFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: WORKFLOW_FRONT_PORT, internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
      // Only the nodes load RivetKit; the front reaches actors over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(WorkflowControlPlane)),
  app.pipe(Effect.provide(WorkflowsRivetLive)),
) {}
