import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Cluster } from "@alchemy.run/aws/EKS/Cluster";
import * as Kubernetes from "@alchemy.run/kubernetes";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Kubernetes.providers()),
  dev: true,
});

class PodNotRunning extends Data.TaggedError("PodNotRunning")<{ readonly pods: string }> {}

/** The emulator runs each EKS cluster's control plane and node in a k3s container. */
const kubectl = Effect.fn(function* (clusterName: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make("docker", ["exec", `floci-aws-eks-${clusterName}`, "kubectl", ...args]),
  );
});

// In `alchemy dev`, an EKS Auto Mode cluster has the Nitro Sandbox
// RuntimeClasses AWS provides, so a Deployment that names one schedules and
// runs. The emulator backs both with gVisor: the pod runs on its own kernel,
// not the node's, as a Nitro Sandbox does.
test.provider(
  "an Auto Mode cluster runs a pod that names a Nitro Sandbox runtime class",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Network("SandboxNetwork", {
            cidrBlock: "10.88.0.0/16",
            availabilityZones: 2,
          });
          const cluster = yield* Cluster("SandboxCluster", {
            compute: "auto",
            resourcesVpcConfig: {
              subnetIds: network.publicSubnetIds,
              endpointPublicAccess: true,
            },
          });
          yield* Kubernetes.Deployment("Sandboxed", {
            cluster,
            name: "sandboxed",
            image: "public.ecr.aws/nginx/nginx:alpine",
            port: 80,
            serviceType: "ClusterIP",
            runtimeClassName: "isolated-sandbox",
          });
          return { clusterName: cluster.clusterName };
        }),
      );

      const runtimeClasses = yield* kubectl(deployed.clusterName, [
        "get",
        "runtimeclass",
        "-o",
        "jsonpath={range .items[*]}{.metadata.name}={.handler}{'\\n'}{end}",
      ]);
      expect(runtimeClasses).toContain("isolated-sandbox=runsc");
      expect(runtimeClasses).toContain("confidential-sandbox=runsc");

      const pod = yield* kubectl(deployed.clusterName, [
        "get",
        "pods",
        "--all-namespaces",
        "-o",
        "jsonpath={range .items[?(@.spec.runtimeClassName=='isolated-sandbox')]}{.metadata.namespace}/{.metadata.name}={.status.phase}{'\\n'}{end}",
      ]).pipe(
        Effect.flatMap((pods) => {
          const running = pods.split("\n").find((line) => line.endsWith("=Running"));
          return running
            ? Effect.succeed(running.slice(0, -"=Running".length))
            : Effect.fail(new PodNotRunning({ pods }));
        }),
        Effect.retry({
          while: (e) => e._tag === "PodNotRunning",
          schedule: Schedule.spaced("5 seconds"),
          times: 24,
        }),
      );
      const [namespace, name] = pod.split("/") as [string, string];
      const kernel = yield* kubectl(deployed.clusterName, [
        "exec",
        "-n",
        namespace,
        name,
        "--",
        "uname",
        "-r",
      ]);
      expect(kernel).toContain("gvisor");

      yield* stack.destroy();

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const containers = yield* spawner.lines(
        ChildProcess.make("docker", ["ps", "--all", "--format", "{{.Names}}"]),
      );
      expect(containers).not.toContain(`floci-aws-eks-${deployed.clusterName}`);
    }),
  {
    tags: ["provider:aws", "provider:aws:eks", "provider:kubernetes", "local"],
    timeout: 600_000,
  },
);
