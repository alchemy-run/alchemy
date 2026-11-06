/** The Kubernetes suite's cluster: Postgres and runners on a local kind cluster. */
import * as ClusterKubernetes from "@alchemy.run/effect-cluster/Kubernetes";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Layer from "effect/Layer";

export const FRONT_PORT = 18620;
export const FRONT_NODE_PORT = 30644;

export const Kind = Kubernetes.LocalCluster("ClusterKind", {
  name: "alchemy-test-cluster",
  registryPort: 5072,
  kubeconfig: ".alchemy/test-cluster.kubeconfig",
  nodes: [
    {
      role: "control-plane",
      extraPortMappings: [{ containerPort: FRONT_NODE_PORT, hostPort: FRONT_PORT }],
    },
  ],
});

export const Database = ClusterKubernetes.Database("Cluster", { cluster: Kind });

export const Default = ClusterKubernetes.DeploymentPool("Default", { replicas: 2 }).pipe(
  Layer.provide(Database),
);

/** A pool of its own for the external program. */
export const Legacy = ClusterKubernetes.DeploymentPool("Legacy", { replicas: 1 }).pipe(
  Layer.provide(Database),
);
