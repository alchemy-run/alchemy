import * as STS from "@distilled.cloud/aws/sts";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as EC2 from "alchemy/AWS/EC2";
import * as EKS from "alchemy/AWS/EKS";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const aws = AWS.providers();

const EKS_ADMIN_PRINCIPAL_ARN = Config.string("EKS_ADMIN_PRINCIPAL_ARN").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

const clusterName = "alchemy-eks-auto-example";
const namespace = "demo";

const toIamPrincipalArn = (arn: string): string | undefined => {
  const assumedRole = arn.match(
    /^arn:([^:]+):sts::([0-9]{12}):assumed-role\/(.+)\/[^/]+$/,
  );
  if (assumedRole) {
    const [, partition, accountId, rolePath] = assumedRole;
    return `arn:${partition}:iam::${accountId}:role/${rolePath}`;
  }

  if (arn.includes(":role/") || arn.includes(":user/")) {
    return arn;
  }

  return undefined;
};

const resolveClusterAdminPrincipalArn = Effect.gen(function* () {
  const configured = yield* EKS_ADMIN_PRINCIPAL_ARN;
  if (configured) {
    return configured;
  }

  const caller = yield* STS.getCallerIdentity({});
  const principalArn =
    typeof caller.Arn === "string" ? toIamPrincipalArn(caller.Arn) : undefined;

  if (!principalArn) {
    return yield* Effect.fail(
      new Error(
        "Unable to infer an IAM principal ARN for cluster access. Set EKS_ADMIN_PRINCIPAL_ARN before deploy.",
      ),
    );
  }

  return principalArn;
});

export default Alchemy.Stack(
  "AwsEksExample",
  {
    providers: aws,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const tags = {
      Example: "aws-eks",
      Surface: "eks",
      Mode: "auto",
    };

    const clusterAdminPrincipalArn = yield* resolveClusterAdminPrincipalArn;

    const network = yield* EC2.Network("Network", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 2,
      nat: "single",
      tags,
    });

    // EKS Auto Mode in one prop: `compute: "auto"` provisions and owns the
    // cluster + node IAM roles and enables managed compute, block storage,
    // and elastic load balancing.
    const cluster = yield* EKS.Cluster("Cluster", {
      clusterName,
      compute: "auto",
      resourcesVpcConfig: {
        subnetIds: network.privateSubnetIds,
        endpointPublicAccess: true,
        endpointPrivateAccess: true,
      },
      tags,
    });

    const clusterAdmin = yield* EKS.AccessEntry("ClusterAdmin", {
      clusterName: cluster.clusterName,
      principalArn: clusterAdminPrincipalArn,
      accessPolicies: [
        {
          policyArn:
            "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
          accessScope: {
            type: "cluster",
          },
        },
      ],
      tags,
    });

    const metricsServer = yield* EKS.Addon("MetricsServer", {
      clusterName: cluster.clusterName,
      addonName: "metrics-server",
      tags,
    });

    const snapshotController = yield* EKS.Addon("SnapshotController", {
      clusterName: cluster.clusterName,
      addonName: "snapshot-controller",
      tags,
    });

    // Raw manifests are applied per-cloud through `EKS.Manifest`, typed by
    // the opt-in `alchemy/Kubernetes` builders.
    const demoNamespace = yield* EKS.Manifest("DemoNamespace", {
      cluster,
      manifest: Kubernetes.namespace({
        metadata: {
          name: namespace,
          labels: {
            "app.kubernetes.io/part-of": "aws-eks-example",
          },
        },
      }),
    });

    // A replicated, load-balanced server from a remote image — no Effect
    // runtime inside the container (external form).
    const echoServer = yield* EKS.Deployment("EchoServer", {
      cluster,
      image: "registry.k8s.io/echoserver:1.10",
      namespace,
      name: "echo-server",
      replicas: 2,
      port: 8080,
      serviceType: "LoadBalancer",
      labels: {
        "app.kubernetes.io/name": "echo-server",
        "app.kubernetes.io/part-of": "aws-eks-example",
      },
      resources: {
        requests: { cpu: "50m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
    });

    // Pod identity comes standard with every EKS platform: this pod's
    // service account is wired to an alchemy-managed IAM role, so the AWS
    // CLI resolves credentials via the container-credentials chain.
    const podIdentityDemo = yield* EKS.Deployment("PodIdentityDemo", {
      cluster,
      image: "public.ecr.aws/aws-cli/aws-cli:2.17.37",
      namespace,
      name: "pod-identity-demo",
      serviceType: "ClusterIP",
      command: ["/bin/sh", "-lc"],
      args: [
        [
          "while true; do",
          "  date;",
          "  aws sts get-caller-identity;",
          "  sleep 60;",
          "done",
        ].join(" "),
      ],
      labels: {
        "app.kubernetes.io/name": "pod-identity-demo",
        "app.kubernetes.io/part-of": "aws-eks-example",
      },
      resources: {
        requests: { cpu: "50m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
      tags,
    });

    // Run-to-completion compute: a one-shot Kubernetes Job.
    const clusterInfoJob = yield* EKS.Job("ClusterInfoJob", {
      cluster,
      image: "public.ecr.aws/docker/library/busybox:1.36",
      namespace,
      name: "cluster-info",
      command: ["/bin/sh", "-lc"],
      args: [
        [
          'echo "demo workload is running on EKS Auto Mode";',
          "nslookup echo-server.demo.svc.cluster.local || true;",
        ].join(" "),
      ],
      labels: {
        "app.kubernetes.io/name": "cluster-info",
        "app.kubernetes.io/part-of": "aws-eks-example",
      },
    });

    return {
      clusterName: cluster.clusterName,
      clusterArn: cluster.clusterArn,
      endpoint: cluster.endpoint,
      adminPrincipalArn: clusterAdmin.principalArn,
      namespace: demoNamespace.name,
      echoDeploymentName: echoServer.deploymentName,
      echoServiceName: echoServer.serviceName,
      echoUrl: echoServer.url,
      podIdentityDeploymentName: podIdentityDemo.deploymentName,
      podIdentityRoleArn: podIdentityDemo.roleArn,
      clusterInfoJobName: clusterInfoJob.jobName,
      metricsServerAddonArn: metricsServer.addonArn,
      snapshotControllerAddonArn: snapshotController.addonArn,
      accessSummary: Output.interpolate`Granted cluster-admin access on ${cluster.clusterName} to ${clusterAdmin.principalArn}.`,
      workloadSummary: Output.interpolate`Demo workloads are declared in TypeScript and reconciled into namespace ${demoNamespace.name} on ${cluster.clusterName}.`,
    };
  }).pipe(Effect.orDie),
);
