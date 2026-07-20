import * as ecr from "@distilled.cloud/aws/ecr";
import * as eks from "@distilled.cloud/aws/eks";
import * as iam from "@distilled.cloud/aws/iam";
import { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import {
  readObject,
  reconcileObjects,
  deleteObjects,
  type KubernetesClusterConnection,
} from "../../Kubernetes/client.ts";
import {
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "../../Kubernetes/types.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost as ServerHostService,
} from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, hasTags } from "../../Tags.ts";
import type { Credentials } from "../Credentials.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { Cluster } from "./Cluster.ts";

export const isServerHost = (value: any): value is ServerHost => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.EKS.ServerHost"
  );
};

/**
 * The subset of an `AWS.EKS.Cluster`'s Attributes the ServerHost needs to
 * connect to the Kubernetes API and place a pod identity association. Passed as
 * the whole `cluster` resource — the engine resolves it to bare attributes at
 * reconcile, giving us the live `endpoint` / `certificateAuthorityData`.
 */
type ClusterConnectionProps = Pick<
  Cluster["Attributes"],
  "clusterName" | "endpoint" | "certificateAuthorityData"
>;

export interface ServerHostProps extends PlatformProps {
  /**
   * Module entrypoint for the bundled server program. Typically
   * `import.meta.url` from an inline Effect program that returns a `{ fetch }`
   * handler (and optionally registers `host.run(...)` background loops).
   */
  main: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Target EKS cluster the workload is deployed onto. Pass the
   * `AWS.EKS.Cluster` resource (e.g. `autoCluster.cluster`); the ServerHost
   * reads its `endpoint` / `certificateAuthorityData` to apply the
   * Deployment + Service via server-side apply.
   */
  cluster: ClusterConnectionProps;
  /**
   * Base name for the generated Deployment / Service / ServiceAccount / IAM
   * role. If omitted, the logical id is used.
   */
  name?: string;
  /**
   * Kubernetes namespace to deploy into. The namespace must already exist
   * (Auto Mode clusters ship a `default` namespace).
   * @default "default"
   */
  namespace?: string;
  /**
   * HTTP port exposed by the container and the Service.
   * @default 3000
   */
  port?: number;
  /**
   * Replica count for the Deployment.
   * @default 1
   */
  replicas?: number;
  /**
   * Kubernetes Service type. `LoadBalancer` provisions a cloud load balancer
   * (an NLB on Auto Mode) and exposes its hostname as the ServerHost `url`.
   * @default "LoadBalancer"
   */
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /**
   * Annotations applied to the Service (e.g. NLB scheme / target-type hints).
   */
  serviceAnnotations?: Record<string, string>;
  /**
   * Container CPU/memory requests + limits (Kubernetes resource quantities).
   */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /**
   * Additional environment variables for the container.
   */
  env?: Record<string, any>;
  /**
   * Docker image build architecture. Auto Mode's default node pools are
   * `linux/amd64`; select `arm64` for Graviton node pools.
   * @default "amd64"
   */
  architecture?: "amd64" | "arm64";
  /**
   * Bundler configuration for the server entrypoint.
   */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
  /**
   * Docker image build: optional full Dockerfile. When omitted, Alchemy
   * generates a Dockerfile for the bundled `index.mjs`.
   */
  docker?: {
    /**
     * Base image when Alchemy generates the Dockerfile.
     * @default public.ecr.aws/docker/library/bun:1
     */
    base?: string;
    /** Full Dockerfile content (replaces the generated Dockerfile). */
    dockerfile?: string;
  };
  /**
   * Managed policy ARNs attached to the generated pod-identity role in
   * addition to the inline policy synthesized from bindings.
   */
  roleManagedPolicyArns?: string[];
  /**
   * Deployment / pod labels. Also used as the Service selector.
   */
  labels?: Record<string, string>;
  /**
   * User-defined tags to apply to ServerHost-owned AWS resources.
   */
  tags?: Record<string, string>;
}

export interface ServerHost extends Resource<
  "AWS.EKS.ServerHost",
  ServerHostProps,
  {
    /** The name of the EKS cluster the server runs on. */
    clusterName: string;
    /** The Kubernetes namespace the server's objects live in. */
    namespace: string;
    /** The name of the Kubernetes Deployment running the server. */
    deploymentName: string;
    /** The name of the Kubernetes Service exposing the server. */
    serviceName: string;
    /** The name of the service account the pods run as. */
    serviceAccountName: string;
    /** The container port the server listens on. */
    port: number;
    /** The URI of the container image the deployment runs. */
    imageUri: string;
    /** The name of the ECR repository holding the server image. */
    repositoryName: string;
    /** The URI of the ECR repository holding the server image. */
    repositoryUri: string;
    /** The ARN of the IAM role pods assume via Pod Identity. */
    roleArn: string;
    /** The name of the IAM role pods assume via Pod Identity. */
    roleName: string;
    /** The ARN of the Pod Identity association binding the role. */
    associationArn: string;
    /** The ID of the Pod Identity association binding the role. */
    associationId: string;
    /**
     * The LoadBalancer hostname when `serviceType` is `LoadBalancer`, otherwise
     * `undefined`. May be `undefined` immediately after a create while the
     * cloud load balancer is still provisioning.
     */
    url: string | undefined;
    /** References to the Kubernetes objects created for the server. */
    kubernetesObjects: KubernetesObjectRef[];
    /** The content hash of the bundled server code. */
    code: {
      hash: string;
    };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type ServerHostServices =
  | Credentials
  | Region
  | ServerHostService
  | AWSEnvironment;

export type ServerHostShape = Main<ServerHostServices>;

export interface ServerHostRuntimeContext extends HostRuntimeContext {
  readonly Type: "AWS.EKS.ServerHost";
}

/**
 * An Effect-native container runtime on Amazon EKS — the Kubernetes analog of
 * `AWS.ECS.Task`.
 *
 * `ServerHost` bundles an inline Effect program, builds and pushes a Docker
 * image to a generated ECR repository, provisions a pod-identity IAM role +
 * `PodIdentityAssociation`, and applies a Kubernetes `Deployment` + `Service`
 * (+ `ServiceAccount`) onto an EKS cluster via server-side apply. It accepts the
 * same `{ env, policyStatements }` host binding contract as `AWS.Lambda.Function`
 * and `AWS.ECS.Task`: every existing AWS `Binding.Service` (S3, DynamoDB, SQS, …)
 * attaches env vars to the pod spec and IAM policy statements to the pod-identity
 * role, so credentials flow into pods through the standard EKS Pod Identity
 * container-credentials chain.
 * @resource
 * @section Creating a ServerHost
 * @example Effect HTTP server on an Auto Mode cluster
 * ```typescript
 * const cluster = yield* AWS.EKS.AutoCluster("AppCluster", { network });
 *
 * class Api extends AWS.EKS.ServerHost<Api>()(
 *   "Api",
 *   { main: import.meta.url, cluster: cluster.cluster, port: 3000 },
 *   Effect.gen(function* () {
 *     const putItem = yield* AWS.DynamoDB.putItem(table);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putItem({ Item: { id: { S: "1" } } });
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
 * ) {}
 * ```
 */
export const ServerHost: Platform<
  ServerHost,
  ServerHostServices,
  ServerHostShape,
  ServerHostRuntimeContext
> = Platform("AWS.EKS.ServerHost", {
  createRuntimeContext: createHostRuntimeContext("AWS.EKS.ServerHost") as (
    id: string,
  ) => ServerHostRuntimeContext,
});

class ServiceNotReady extends Data.TaggedError("EKS.ServiceNotReady")<{}> {}

// Bounded ~3 min wait for the cloud load balancer to publish its hostname
// (an Auto Mode NLB typically appears within 2–3 min of the Service apply).
const loadBalancerRetrySchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(36),
]);

/**
 * Explicitly-typed pipeable retry for the LB-hostname wait. An inline
 * `Effect.retry` in the provider leaks `Retry.Return`'s conditional into
 * declaration emit and widens the provider layer to `unknown` R.
 */
const retryUntilServiceReady = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (error) => error instanceof ServiceNotReady,
    schedule: loadBalancerRetrySchedule,
  });

const toConnection = (
  cluster: ClusterConnectionProps,
): KubernetesClusterConnection => {
  if (!cluster.endpoint || !cluster.certificateAuthorityData) {
    throw new Error(
      `EKS cluster '${cluster.clusterName}' is missing endpoint or certificate authority data`,
    );
  }
  return {
    clusterName: cluster.clusterName,
    endpoint: cluster.endpoint,
    certificateAuthorityData: cluster.certificateAuthorityData,
  };
};

export const ServerHostProvider = () =>
  Provider.effect(
    ServerHost,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const docker = yield* Docker;

      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const toBaseName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 200, lowercase: true }).pipe(
              Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")),
            );

      const createRoleName = (id: string) =>
        createPhysicalName({ id: `${id}-pod-role`, maxLength: 64 });

      const createPolicyName = (id: string) =>
        createPhysicalName({ id: `${id}-pod-policy`, maxLength: 128 });

      const createRepositoryName = (id: string) =>
        createPhysicalName({
          id: `${id}-repo`,
          maxLength: 256,
          lowercase: true,
        });

      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      // Ensure the pod-identity IAM role exists (trusts pods.eks.amazonaws.com).
      // Idempotent: creates on miss, adopts a role we already own on race.
      const ensurePodRole = Effect.fn(function* ({
        id,
        roleName,
        managedPolicyArns,
      }: {
        id: string;
        roleName: string;
        managedPolicyArns?: string[];
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "pods.eks.amazonaws.com" },
                  Action: ["sts:AssumeRole", "sts:TagSession"],
                },
              ],
            }),
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }).pipe(
                Effect.filterOrFail(
                  (existing) => hasTags(tags, existing.Role?.Tags),
                  () =>
                    new Error(
                      `Role '${roleName}' already exists and is not managed by alchemy`,
                    ),
                ),
              ),
            ),
          );
        for (const policyArn of managedPolicyArns ?? []) {
          yield* iam
            .attachRolePolicy({ RoleName: roleName, PolicyArn: policyArn })
            .pipe(Effect.catchTag("LimitExceededException", () => Effect.void));
        }
        return role.Role!.Arn!;
      });

      const ensureRepository = Effect.fn(function* ({
        repositoryName,
        tags,
      }: {
        repositoryName: string;
        tags: Record<string, string>;
      }) {
        const created = yield* ecr
          .createRepository({
            repositoryName,
            imageTagMutability: "MUTABLE",
            imageScanningConfiguration: { scanOnPush: true },
            tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("RepositoryAlreadyExistsException", () =>
              ecr
                .describeRepositories({ repositoryNames: [repositoryName] })
                .pipe(
                  Effect.map((existing) => ({
                    repository: existing.repositories?.[0],
                  })),
                ),
            ),
          );
        const repository = created.repository;
        if (!repository?.repositoryUri) {
          return yield* Effect.die(
            new Error(`Failed to resolve ECR repository '${repositoryName}'`),
          );
        }
        return { repositoryUri: repository.repositoryUri };
      });

      // Collect env + IAM from bindings and land the policy on the pod role.
      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        bindings: ResourceBinding<ServerHost["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<ServerHost["Binding"]> & {
              action?: string;
            },
          ) => binding.action !== "delete",
        );

        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, value) => ({ ...acc, ...value }), {});

        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((statement) => ({
              ...statement,
              Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
        );

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            }),
          });
        } else {
          yield* iam
            .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return env;
      });

      // Observe an existing pod identity association for (cluster, ns, sa).
      const findAssociation = Effect.fn(function* ({
        clusterName,
        namespace,
        serviceAccount,
      }: {
        clusterName: string;
        namespace: string;
        serviceAccount: string;
      }) {
        const listed = yield* eks.listPodIdentityAssociations({
          clusterName,
          namespace,
          serviceAccount,
        });
        const summary = listed.associations?.[0];
        if (!summary?.associationId) return undefined;
        const described = yield* eks
          .describePodIdentityAssociation({
            clusterName,
            associationId: summary.associationId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const association = described?.association;
        if (!association?.associationArn || !association.associationId) {
          return undefined;
        }
        return {
          associationArn: association.associationArn,
          associationId: association.associationId,
          roleArn: association.roleArn,
        };
      });

      // Ensure the pod identity association exists and points at roleArn.
      const ensureAssociation = Effect.fn(function* ({
        id,
        clusterName,
        namespace,
        serviceAccount,
        roleArn,
      }: {
        id: string;
        clusterName: string;
        namespace: string;
        serviceAccount: string;
        roleArn: string;
      }) {
        let state = yield* findAssociation({
          clusterName,
          namespace,
          serviceAccount,
        });
        if (!state) {
          yield* eks
            .createPodIdentityAssociation({
              clusterName,
              namespace,
              serviceAccount,
              roleArn,
              tags: yield* createInternalTags(id),
              clientRequestToken: yield* toClientRequestToken(id, "assoc"),
            })
            .pipe(Effect.catchTag("ResourceInUseException", () => Effect.void));
          state = yield* findAssociation({
            clusterName,
            namespace,
            serviceAccount,
          });
          if (!state) {
            return yield* Effect.fail(
              new Error(
                `PodIdentityAssociation '${namespace}/${serviceAccount}' could not be read after creation`,
              ),
            );
          }
        } else if (state.roleArn !== roleArn) {
          yield* eks.updatePodIdentityAssociation({
            clusterName,
            associationId: state.associationId,
            roleArn,
            clientRequestToken: yield* toClientRequestToken(id, "assoc-update"),
          });
        }
        return {
          associationArn: state.associationArn,
          associationId: state.associationId,
        };
      });

      const bundleProgram = Effect.fn(function* (
        id: string,
        props: ServerHostProps,
      ) {
        const handler = props.handler ?? "default";
        const realMain = yield* resolveMainPath(props.main);
        const cwd = yield* findCwdForBundle(realMain);

        const buildBundle = Effect.fn(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              ...props.build?.input,
              input: entry,
              cwd,
              platform: "node",
              // The container runs on `bun`; keep `bun`/`bun:*` external and
              // resolve the `bun` export condition so `@effect/platform-bun`
              // picks its Bun implementations.
              external: [
                "bun",
                "bun:*",
                ...((props.build?.input?.external as string[] | undefined) ??
                  []),
              ],
              resolve: {
                conditionNames: ["bun", "import", "module", "default"],
                ...props.build?.input?.resolve,
              },
              plugins: [props.build?.input?.plugins, plugins],
            },
            {
              ...props.build?.output,
              format: "esm",
              sourcemap: props.build?.output?.sourcemap ?? false,
              minify: props.build?.output?.minify ?? false,
              entryFileNames: "index.mjs",
            },
          );
        });

        const bundleOutput = props.isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as handler } from ${JSON.stringify(importPath)};

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is served and host.run loops stay alive. Credentials use the full
// Node provider chain so EKS Pod Identity's container-credentials endpoint
// (AWS_CONTAINER_CREDENTIALS_FULL_URI + token file) resolves inside the pod.
const program = handler.pipe(
  Effect.flatMap((host) => host.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromChain()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("ServerHost bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("ServerHost bootstrap failed:", err);
  process.exit(1);
});
`,
              ),
            );

        // Return every emitted file (entry + shared chunks). Dropping any chunk
        // crashes the container with `Cannot find module './chunk-XXX.js'`.
        const files = bundleOutput.files.map((file) => ({
          path: file.path,
          content:
            typeof file.content === "string"
              ? new TextEncoder().encode(file.content)
              : file.content,
        }));

        return { files, hash: bundleOutput.hash };
      });

      const buildAndPushImage = Effect.fn(function* ({
        id,
        repositoryUri,
        hash,
        files,
        props,
      }: {
        id: string;
        repositoryUri: string;
        hash: string;
        files: { path: string; content: Uint8Array<ArrayBufferLike> }[];
        props: ServerHostProps;
      }) {
        const realMain = yield* resolveMainPath(props.main);
        const contextDir = yield* getStableContextDir(
          realMain,
          dotAlchemy,
          `${id}-image`,
        );
        const imageUri = `${repositoryUri}:${hash}`;
        const port = props.port ?? 3000;

        const generatedDockerfile = (() => {
          const base =
            props.docker?.base ?? "public.ecr.aws/docker/library/bun:1";
          const lines = [
            `FROM ${base}`,
            `WORKDIR /app`,
            `COPY index.mjs /app/index.mjs`,
            `COPY *.js /app/`,
            `ENV PORT=${String(port)}`,
            `EXPOSE ${String(port)}`,
            `ENTRYPOINT ["bun", "/app/index.mjs"]`,
          ];
          return `${lines.join("\n")}\n`;
        })();

        const dockerfile = props.docker?.dockerfile ?? generatedDockerfile;

        yield* docker.materialize({
          context: contextDir,
          dockerfile,
          files: files.map((file, index) => ({
            path: index === 0 ? "index.mjs" : file.path,
            content: file.content,
          })),
        });
        const buildPlatform =
          props.architecture === "arm64" ? "linux/arm64" : "linux/amd64";
        return yield* buildAndPushEcrImage(docker, {
          imageUri,
          context: contextDir,
          platform: buildPlatform,
        });
      });

      // Read a LoadBalancer Service's assigned hostname (bounded wait).
      const waitForLoadBalancer = (
        connection: KubernetesClusterConnection,
        service: KubernetesObjectRef,
      ) =>
        readObject({ connection, object: service }).pipe(
          Effect.map((response) => {
            const ingress = (
              response as {
                status?: {
                  loadBalancer?: {
                    ingress?: { hostname?: string; ip?: string }[];
                  };
                };
              }
            )?.status?.loadBalancer?.ingress?.[0];
            return ingress?.hostname ?? ingress?.ip;
          }),
          Effect.flatMap((hostname) =>
            hostname
              ? Effect.succeed(hostname)
              : Effect.fail(new ServiceNotReady()),
          ),
          retryUntilServiceReady,
          Effect.catchTag("EKS.ServiceNotReady", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: [
          "repositoryName",
          "repositoryUri",
          "roleArn",
          "roleName",
          "clusterName",
          "namespace",
          "serviceAccountName",
          "deploymentName",
          "serviceName",
        ],
        // A ServerHost's identity spans an ECR repo, a pod-identity IAM role,
        // an EKS pod-identity association, and in-cluster Kubernetes objects.
        // There is no single AWS enumeration that faithfully reconstructs that
        // composite (the image hash and applied manifests live in-cluster), so
        // enumeration is intentionally empty — `read` (below) refreshes a
        // known instance from its persisted output.
        list: () => Effect.succeed([] as ServerHost["Attributes"][]),
        diff: Effect.fn(function* ({ olds = {} as ServerHostProps, news }) {
          if (!isResolved(news)) return;
          // The pod-identity association keys on (cluster, namespace,
          // serviceAccount); a change to either forces a replacement. Only
          // compare when the old value is present so a first create (empty
          // `olds`) doesn't spuriously replace.
          if (
            olds.cluster?.clusterName &&
            olds.cluster.clusterName !== news.cluster?.clusterName
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds.namespace !== undefined &&
            (olds.namespace ?? "default") !== (news.namespace ?? "default")
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const described = yield* eks
            .describePodIdentityAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!described?.association?.associationArn) {
            return undefined;
          }
          return output;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const connection = toConnection(news.cluster);
          const clusterName = news.cluster.clusterName;
          const namespace = news.namespace ?? "default";
          const port = news.port ?? 3000;
          const serviceType = news.serviceType ?? "LoadBalancer";

          const baseName =
            output?.deploymentName ?? (yield* toBaseName(id, news));
          const serviceAccountName = output?.serviceAccountName ?? baseName;
          const roleName = output?.roleName ?? (yield* createRoleName(id));
          const policyName = yield* createPolicyName(id);
          const repositoryName =
            output?.repositoryName ?? (yield* createRepositoryName(id));
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Ensure IAM role + inline policy from bindings.
          const roleArn =
            output?.roleArn ??
            (yield* ensurePodRole({
              id,
              roleName,
              managedPolicyArns: news.roleManagedPolicyArns,
            }));
          const bindingEnv = yield* attachBindings({
            roleName,
            policyName,
            bindings,
          });

          // Ensure the pod identity association wires the role to the SA.
          const { associationArn, associationId } = yield* ensureAssociation({
            id,
            clusterName,
            namespace,
            serviceAccount: serviceAccountName,
            roleArn,
          });

          // Build + push the image.
          const { repositoryUri } =
            output?.repositoryUri && output.repositoryName === repositoryName
              ? { repositoryUri: output.repositoryUri }
              : yield* ensureRepository({ repositoryName, tags });
          const { files, hash } = yield* bundleProgram(id, news);
          const imageUri = yield* buildAndPushImage({
            id,
            repositoryUri,
            hash,
            files,
            props: news,
          });

          // Synthesize the Kubernetes objects. Container env merges binding env
          // (Output-referenced resource attributes flow via the RuntimeContext
          // into `news.env`), alchemy env, and user env.
          const labels = news.labels ?? { "app.kubernetes.io/name": baseName };
          const containerEnv = {
            ...bindingEnv,
            ...alchemyEnv,
            PORT: String(port),
            ...news.env,
          };

          const serviceAccountObject: KubernetesObjectDefinition = {
            apiVersion: "v1",
            kind: "ServiceAccount",
            metadata: { name: serviceAccountName, namespace, labels },
          };
          const deploymentObject: KubernetesObjectDefinition = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: baseName, namespace, labels },
            spec: {
              replicas: news.replicas ?? 1,
              selector: { matchLabels: labels },
              template: {
                metadata: { labels },
                spec: {
                  serviceAccountName,
                  containers: [
                    {
                      name: baseName,
                      image: imageUri,
                      ports: [{ containerPort: port }],
                      env: Object.entries(containerEnv).map(
                        ([name, value]) => ({
                          name,
                          value:
                            typeof value === "string"
                              ? value
                              : JSON.stringify(value),
                        }),
                      ),
                      resources: news.resources,
                    },
                  ],
                },
              },
            },
          };
          const serviceObject: KubernetesObjectDefinition = {
            apiVersion: "v1",
            kind: "Service",
            metadata: {
              name: baseName,
              namespace,
              labels,
              annotations: news.serviceAnnotations,
            },
            spec: {
              type: serviceType,
              selector: labels,
              ports: [{ port, targetPort: port, protocol: "TCP" }],
            },
          };

          const desiredObjects = [
            serviceAccountObject,
            deploymentObject,
            serviceObject,
          ];

          const kubernetesObjects = yield* reconcileObjects({
            connection,
            previousObjects: output?.kubernetesObjects ?? [],
            desiredObjects,
          });

          yield* session.note(
            `Applied EKS ServerHost ${namespace}/${baseName}`,
          );

          // Resolve the LoadBalancer hostname if applicable.
          const url =
            serviceType === "LoadBalancer"
              ? yield* waitForLoadBalancer(
                  connection,
                  toKubernetesObjectRef(serviceObject),
                )
              : undefined;

          return {
            clusterName,
            namespace,
            deploymentName: baseName,
            serviceName: baseName,
            serviceAccountName,
            port,
            imageUri,
            repositoryName,
            repositoryUri,
            roleArn,
            roleName,
            associationArn,
            associationId,
            url,
            kubernetesObjects,
            code: { hash },
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Delete the in-cluster objects. Re-describe the cluster for a fresh
          // endpoint + CA (the Attributes don't cache them). If the cluster is
          // already gone (destroyed alongside the ServerHost), its objects went
          // with it — skip. Tolerate any API failure so delete stays idempotent.
          if ((output.kubernetesObjects ?? []).length > 0) {
            const described = yield* eks
              .describeCluster({ name: output.clusterName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            const cluster = described?.cluster;
            if (cluster?.endpoint && cluster.certificateAuthority?.data) {
              yield* deleteObjects({
                connection: {
                  clusterName: output.clusterName,
                  endpoint: cluster.endpoint,
                  certificateAuthorityData: cluster.certificateAuthority.data,
                },
                objects: output.kubernetesObjects ?? [],
              }).pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* eks
            .deletePodIdentityAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );

          yield* iam.listRolePolicies({ RoleName: output.roleName }).pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed({ PolicyNames: [] as string[] }),
            ),
            Effect.flatMap((policies) =>
              Effect.all(
                (policies.PolicyNames ?? []).map((policyName) =>
                  iam
                    .deleteRolePolicy({
                      RoleName: output.roleName,
                      PolicyName: policyName,
                    })
                    .pipe(
                      Effect.catchTag(
                        "NoSuchEntityException",
                        () => Effect.void,
                      ),
                    ),
                ),
              ),
            ),
          );

          yield* iam
            .listAttachedRolePolicies({ RoleName: output.roleName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed({ AttachedPolicies: [] }),
              ),
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.AttachedPolicies ?? []).map((policy) =>
                    iam
                      .detachRolePolicy({
                        RoleName: output.roleName,
                        PolicyArn: policy.PolicyArn!,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
            );

          yield* iam
            .deleteRole({ RoleName: output.roleName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
