/** A kind cluster running a control plane and a pool of nodes beside it. */
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as RivetKubernetes from "@alchemy.run/rivet/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodePortUrl } from "../../../Kubernetes/fixtures/kind.ts";

export const CONTROL_PLANE_NODE_PORT = 30642;
export const FRONT_NODE_PORT = 30643;

// Named from the stack and stage, with its registry and node ports on host
// free host ports: the suite runs beside itself in other worktrees.
export const Kind = Kubernetes.LocalCluster("RivetKind", {
  registryPort: 0,
  kubeconfig: ".alchemy/test-rivet.kubeconfig",
  nodes: [
    {
      role: "control-plane",
      extraPortMappings: [
        { containerPort: CONTROL_PLANE_NODE_PORT, hostPort: 0 },
        { containerPort: FRONT_NODE_PORT, hostPort: 0 },
      ],
    },
  ],
});

export const Cluster = RivetKubernetes.StatefulSetControlPlane("Rivet", {
  cluster: Kind,
  expose: {
    type: "NodePort",
    nodePort: CONTROL_PLANE_NODE_PORT,
    endpoint: Effect.map(Kind, (kind) =>
      kind.ports.pipe(Output.map((ports) => nodePortUrl(ports, CONTROL_PLANE_NODE_PORT))),
    ),
  },
});
export const Default = RivetKubernetes.DeploymentPool("Default").pipe(Layer.provide(Cluster));
// Rivet Services: Durable Streams.
export const Services = RivetKubernetes.ServicesPool("Services").pipe(Layer.provide(Cluster));
