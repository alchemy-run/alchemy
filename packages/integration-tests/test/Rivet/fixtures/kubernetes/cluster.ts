/** A kind cluster running a control plane and a pool of nodes beside it. */
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as RivetKubernetes from "@alchemy.run/rivet/Kubernetes";
import * as Layer from "effect/Layer";

export const CONTROL_PLANE_PORT = 16450;
export const FRONT_PORT = 18450;
export const FRONT_NODE_PORT = 30643;

export const Kind = Kubernetes.LocalCluster("RivetKind", {
  name: "alchemy-test-rivet",
  registryPort: 5071,
  kubeconfig: ".alchemy/test-rivet.kubeconfig",
  nodes: [
    {
      role: "control-plane",
      extraPortMappings: [
        { containerPort: 30642, hostPort: CONTROL_PLANE_PORT },
        { containerPort: FRONT_NODE_PORT, hostPort: FRONT_PORT },
      ],
    },
  ],
});

export const Cluster = RivetKubernetes.ControlPlane("Rivet", {
  cluster: Kind,
  expose: {
    type: "NodePort",
    nodePort: 30642,
    endpoint: `http://localhost:${CONTROL_PLANE_PORT}`,
  },
});
export const Default = RivetKubernetes.Pool("Default").pipe(Layer.provide(Cluster));
