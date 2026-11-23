import * as Kubernetes from "@alchemy.run/kubernetes";

/** A node port the cluster forwards to the host. */
export const LOCAL_NODE_PORT = 30090;

/**
 * The shared `Kubernetes.LocalCluster` for LocalCluster.test.ts: a kind
 * cluster named from the stack and stage, plus its image registry on a port
 * Docker picks, so the suite runs beside itself in other worktrees. Its
 * kubeconfig is under `.alchemy/`, so the run never touches `~/.kube/config`.
 */
export const TestLocalCluster = Kubernetes.LocalCluster("TestLocalCluster", {
  registryPort: 0,
  kubeconfig: ".alchemy/test-local-cluster.kubeconfig",
  // Forwarded to a host port kind picks.
  nodes: [
    { role: "control-plane", extraPortMappings: [{ containerPort: LOCAL_NODE_PORT, hostPort: 0 }] },
  ],
});
