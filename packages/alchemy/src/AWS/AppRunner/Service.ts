import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  readAppRunnerTags,
  syncAppRunnerTags,
  toWireTags,
} from "./internal.ts";

/**
 * Container image source for an App Runner service.
 */
export interface ServiceImageRepository {
  /**
   * Image identifier: a private ECR image URI
   * (`{account}.dkr.ecr.{region}.amazonaws.com/{repo}:{tag}`) or a public
   * ECR image (`public.ecr.aws/{alias}/{repo}:{tag}`).
   */
  imageIdentifier: string;
  /**
   * Repository type. `ECR` (private, requires `accessRoleArn`) or
   * `ECR_PUBLIC` (public gallery images, no access role).
   */
  imageRepositoryType: "ECR" | "ECR_PUBLIC";
  /**
   * Port the application listens on.
   * @default "8080"
   */
  port?: string;
  /**
   * Command App Runner runs to start the container. Overrides the image's
   * default start command.
   */
  startCommand?: string;
  /**
   * Environment variables available to the running service.
   */
  runtimeEnvironmentVariables?: Record<string, string>;
  /**
   * Secrets exposed as environment variables. Values are Secrets Manager
   * secret ARNs or SSM parameter ARNs (the instance role must be able to
   * read them).
   */
  runtimeEnvironmentSecrets?: Record<string, string>;
}

/**
 * Compute resources for each instance of the service.
 */
export interface ServiceInstanceConfiguration {
  /**
   * CPU units per instance: `"256"` (0.25 vCPU), `"512"`, `"1024"`,
   * `"2048"`, or `"4096"`. The `"0.25 vCPU"`-style forms are also
   * accepted.
   * @default "1024"
   */
  cpu?: string;
  /**
   * Memory per instance in MB: `"512"`, `"1024"`, `"2048"`, `"3072"`,
   * `"4096"`, `"6144"`, `"8192"`, `"10240"`, or `"12288"`. The
   * `"2 GB"`-style forms are also accepted.
   * @default "2048"
   */
  memory?: string;
  /**
   * IAM role assumed by the running service (analogous to an ECS task
   * role). Required when the app calls AWS APIs or reads
   * `runtimeEnvironmentSecrets`.
   */
  instanceRoleArn?: string;
}

/**
 * Health check App Runner performs against the service.
 */
export interface ServiceHealthCheckConfiguration {
  /**
   * Health check protocol.
   * @default "TCP"
   */
  protocol?: "TCP" | "HTTP";
  /**
   * URL path for HTTP health checks.
   * @default "/"
   */
  path?: string;
  /**
   * Time between health checks, e.g. `"5 seconds"` or
   * `Duration.seconds(5)` (1-20 seconds on the wire).
   * @default "5 seconds"
   */
  interval?: Duration.Input;
  /**
   * Time to wait for a response, e.g. `"2 seconds"` or
   * `Duration.seconds(2)` (1-20 seconds on the wire).
   * @default "2 seconds"
   */
  timeout?: Duration.Input;
  /**
   * Consecutive successful checks before the target is healthy (1-20).
   * @default 1
   */
  healthyThreshold?: number;
  /**
   * Consecutive failed checks before the target is unhealthy (1-20).
   * @default 5
   */
  unhealthyThreshold?: number;
}

/**
 * Network settings for inbound and outbound service traffic.
 */
export interface ServiceNetworkConfiguration {
  /**
   * Outbound traffic routing. `DEFAULT` egresses through App Runner;
   * `VPC` routes through the VPC connector named by `vpcConnectorArn`.
   * @default "DEFAULT"
   */
  egressType?: "DEFAULT" | "VPC";
  /**
   * ARN of the App Runner VPC connector for `egressType: "VPC"`.
   */
  vpcConnectorArn?: string;
  /**
   * Whether the service is reachable from the public internet. Set to
   * false to only allow access from a VPC ingress connection.
   * @default true
   */
  isPubliclyAccessible?: boolean;
  /**
   * IP address type for the public endpoint.
   * @default "IPV4"
   */
  ipAddressType?: "IPV4" | "DUAL_STACK";
}

export interface ServiceProps {
  /**
   * Name of the service. Must be 4-40 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces
   * the service.
   */
  serviceName?: string;
  /**
   * Container image source for the service. Code-repository (GitHub)
   * sources are not supported — they require an App Runner Connection
   * whose handshake is completed manually in the console.
   */
  imageRepository: ServiceImageRepository;
  /**
   * Whether App Runner automatically deploys new image versions pushed to
   * the (private ECR only) repository.
   * @default false
   */
  autoDeploymentsEnabled?: boolean;
  /**
   * IAM role App Runner assumes to pull from private ECR (must trust
   * `build.apprunner.amazonaws.com`). Required for
   * `imageRepositoryType: "ECR"`, forbidden for `ECR_PUBLIC`.
   */
  accessRoleArn?: string;
  /**
   * CPU, memory, and instance role for the running service.
   */
  instanceConfiguration?: ServiceInstanceConfiguration;
  /**
   * Health check configuration.
   */
  healthCheckConfiguration?: ServiceHealthCheckConfiguration;
  /**
   * Inbound/outbound network configuration.
   */
  networkConfiguration?: ServiceNetworkConfiguration;
  /**
   * ARN of an App Runner auto scaling configuration. Defaults to the
   * account's default configuration.
   */
  autoScalingConfigurationArn?: string;
  /**
   * Customer-managed KMS key ARN for encrypting stored copies of the
   * image and configuration. Changing the key replaces the service.
   * @default AWS-owned key
   */
  kmsKeyArn?: string;
  /**
   * User-defined tags for the service.
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "AWS.AppRunner.Service",
  ServiceProps,
  {
    serviceName: string;
    serviceArn: string;
    serviceId: string;
    serviceUrl: string | undefined;
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS App Runner service running a container image.
 *
 * App Runner is the zero-infrastructure way to run a container behind an
 * HTTPS endpoint: it provisions, load-balances, scales, and patches the
 * fleet for you. Service creation and deletion are asynchronous and take
 * several minutes; the provider waits (bounded) for operations to settle.
 * @resource
 * @section Creating a Service
 * @example Public ECR Image
 * ```typescript
 * const service = yield* AppRunner.Service("Hello", {
 *   imageRepository: {
 *     imageIdentifier: "public.ecr.aws/aws-containers/hello-app-runner:latest",
 *     imageRepositoryType: "ECR_PUBLIC",
 *     port: "8000",
 *   },
 *   instanceConfiguration: { cpu: "256", memory: "512" },
 * });
 * // service.serviceUrl -> "xxxxxxxx.us-west-2.awsapprunner.com"
 * ```
 *
 * @example Private ECR Image with Access Role
 * ```typescript
 * const service = yield* AppRunner.Service("Api", {
 *   imageRepository: {
 *     imageIdentifier: `${repository.repositoryUri}:latest`,
 *     imageRepositoryType: "ECR",
 *     port: "8080",
 *     runtimeEnvironmentVariables: { NODE_ENV: "production" },
 *   },
 *   accessRoleArn: accessRole.roleArn,
 *   autoDeploymentsEnabled: true,
 * });
 * ```
 *
 * @section Scaling and Networking
 * @example Custom Auto Scaling and VPC Egress
 * ```typescript
 * const service = yield* AppRunner.Service("Api", {
 *   imageRepository: {
 *     imageIdentifier: "public.ecr.aws/aws-containers/hello-app-runner:latest",
 *     imageRepositoryType: "ECR_PUBLIC",
 *     port: "8000",
 *   },
 *   autoScalingConfigurationArn: scaling.autoScalingConfigurationArn,
 *   networkConfiguration: {
 *     egressType: "VPC",
 *     vpcConnectorArn: connector.vpcConnectorArn,
 *   },
 * });
 * ```
 */
export const Service = Resource<Service>("AWS.AppRunner.Service");

class AppRunnerServiceNotSettled extends Data.TaggedError(
  "AppRunnerServiceNotSettled",
)<{
  readonly serviceArn: string;
  readonly status: string;
}> {}

/**
 * Case-insensitive status comparison — App Runner returns lowercase
 * statuses for some resource types despite documenting uppercase.
 */
const statusIs = (status: string | undefined, expected: string): boolean =>
  status?.toUpperCase() === expected;

/** Normalize the vCPU-style CPU forms to the numeric wire echo. */
const normalizeCpu = (cpu: string): string =>
  ({
    "0.25 vCPU": "256",
    "0.5 vCPU": "512",
    "1 vCPU": "1024",
    "2 vCPU": "2048",
    "4 vCPU": "4096",
  })[cpu] ?? cpu;

/** Normalize the GB-style memory forms to the numeric wire echo. */
const normalizeMemory = (memory: string): string =>
  ({
    "0.5 GB": "512",
    "1 GB": "1024",
    "2 GB": "2048",
    "3 GB": "3072",
    "4 GB": "4096",
    "6 GB": "6144",
    "8 GB": "8192",
    "10 GB": "10240",
    "12 GB": "12288",
  })[memory] ?? memory;

/** Unwrap distilled's sensitive-string decoding to a plain value. */
const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const plainRecord = (
  record:
    | { [key: string]: string | Redacted.Redacted<string> | undefined }
    | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) => {
      const v = plain(value);
      return v === undefined ? [] : [[key, v]];
    }),
  );

const sameRecord = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k])
  );
};

const toWireSource = (props: ServiceProps): apprunner.SourceConfiguration => ({
  ImageRepository: {
    ImageIdentifier: props.imageRepository.imageIdentifier,
    ImageRepositoryType: props.imageRepository.imageRepositoryType,
    ImageConfiguration: {
      Port: props.imageRepository.port,
      StartCommand: props.imageRepository.startCommand,
      RuntimeEnvironmentVariables:
        props.imageRepository.runtimeEnvironmentVariables,
      RuntimeEnvironmentSecrets:
        props.imageRepository.runtimeEnvironmentSecrets,
    },
  },
  AutoDeploymentsEnabled: props.autoDeploymentsEnabled,
  AuthenticationConfiguration: props.accessRoleArn
    ? { AccessRoleArn: props.accessRoleArn }
    : undefined,
});

const toWireInstance = (
  instance: ServiceInstanceConfiguration | undefined,
): apprunner.InstanceConfiguration | undefined =>
  instance === undefined
    ? undefined
    : {
        Cpu: instance.cpu,
        Memory: instance.memory,
        InstanceRoleArn: instance.instanceRoleArn,
      };

const toWireHealthCheck = (
  healthCheck: ServiceHealthCheckConfiguration | undefined,
): apprunner.HealthCheckConfiguration | undefined =>
  healthCheck === undefined
    ? undefined
    : {
        Protocol: healthCheck.protocol,
        Path: healthCheck.path,
        Interval: toSeconds(healthCheck.interval),
        Timeout: toSeconds(healthCheck.timeout),
        HealthyThreshold: healthCheck.healthyThreshold,
        UnhealthyThreshold: healthCheck.unhealthyThreshold,
      };

const toWireNetwork = (
  network: ServiceNetworkConfiguration | undefined,
): apprunner.NetworkConfiguration | undefined =>
  network === undefined
    ? undefined
    : {
        EgressConfiguration:
          network.egressType !== undefined ||
          network.vpcConnectorArn !== undefined
            ? {
                EgressType: network.egressType,
                VpcConnectorArn: network.vpcConnectorArn,
              }
            : undefined,
        IngressConfiguration:
          network.isPubliclyAccessible !== undefined
            ? { IsPubliclyAccessible: network.isPubliclyAccessible }
            : undefined,
        IpAddressType: network.ipAddressType,
      };

/**
 * True when any user-specified aspect of the source configuration differs
 * from the observed one. Only fields the user actually specified are
 * compared — the service fills in defaults that must not trigger
 * spurious deployments.
 */
const sourceDrifted = (
  news: ServiceProps,
  observed: apprunner.SourceConfiguration | undefined,
): boolean => {
  const image = observed?.ImageRepository;
  const config = image?.ImageConfiguration;
  const desired = news.imageRepository;
  return (
    image?.ImageIdentifier !== desired.imageIdentifier ||
    image?.ImageRepositoryType !== desired.imageRepositoryType ||
    (desired.port !== undefined && config?.Port !== desired.port) ||
    (desired.startCommand !== undefined &&
      plain(config?.StartCommand) !== desired.startCommand) ||
    (desired.runtimeEnvironmentVariables !== undefined &&
      !sameRecord(
        plainRecord(config?.RuntimeEnvironmentVariables),
        desired.runtimeEnvironmentVariables,
      )) ||
    (desired.runtimeEnvironmentSecrets !== undefined &&
      !sameRecord(
        plainRecord(config?.RuntimeEnvironmentSecrets),
        desired.runtimeEnvironmentSecrets,
      )) ||
    (news.autoDeploymentsEnabled !== undefined &&
      observed?.AutoDeploymentsEnabled !== news.autoDeploymentsEnabled) ||
    (news.accessRoleArn !== undefined &&
      observed?.AuthenticationConfiguration?.AccessRoleArn !==
        news.accessRoleArn)
  );
};

const instanceDrifted = (
  desired: ServiceInstanceConfiguration | undefined,
  observed: apprunner.InstanceConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((desired.cpu !== undefined &&
    normalizeCpu(observed?.Cpu ?? "") !== normalizeCpu(desired.cpu)) ||
    (desired.memory !== undefined &&
      normalizeMemory(observed?.Memory ?? "") !==
        normalizeMemory(desired.memory)) ||
    (desired.instanceRoleArn !== undefined &&
      observed?.InstanceRoleArn !== desired.instanceRoleArn));

const healthCheckDrifted = (
  desired: ServiceHealthCheckConfiguration | undefined,
  observed: apprunner.HealthCheckConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((desired.protocol !== undefined &&
    observed?.Protocol !== desired.protocol) ||
    (desired.path !== undefined && observed?.Path !== desired.path) ||
    (desired.interval !== undefined &&
      observed?.Interval !== toSeconds(desired.interval)) ||
    (desired.timeout !== undefined &&
      observed?.Timeout !== toSeconds(desired.timeout)) ||
    (desired.healthyThreshold !== undefined &&
      observed?.HealthyThreshold !== desired.healthyThreshold) ||
    (desired.unhealthyThreshold !== undefined &&
      observed?.UnhealthyThreshold !== desired.unhealthyThreshold));

const networkDrifted = (
  desired: ServiceNetworkConfiguration | undefined,
  observed: apprunner.NetworkConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((desired.egressType !== undefined &&
    observed?.EgressConfiguration?.EgressType !== desired.egressType) ||
    (desired.vpcConnectorArn !== undefined &&
      observed?.EgressConfiguration?.VpcConnectorArn !==
        desired.vpcConnectorArn) ||
    (desired.isPubliclyAccessible !== undefined &&
      observed?.IngressConfiguration?.IsPubliclyAccessible !==
        desired.isPubliclyAccessible) ||
    (desired.ipAddressType !== undefined &&
      observed?.IpAddressType !== desired.ipAddressType));

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ServiceProps>) =>
        props.serviceName
          ? Effect.succeed(props.serviceName)
          : createPhysicalName({ id, maxLength: 40 });

      /** Describe a service; a missing or DELETED service reads as absent. */
      const readService = Effect.fn(function* (arn: string) {
        const response = yield* apprunner
          .describeService({ ServiceArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const service = response?.Service;
        return service === undefined || statusIs(service.Status, "DELETED")
          ? undefined
          : service;
      });

      /** Find a live service by name (list has no name filter). */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* apprunner.listServices.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.ServiceSummaryList ?? []),
          ),
        );
        const summary = summaries.find(
          (s) =>
            s.ServiceName === name &&
            !statusIs(s.Status, "DELETED") &&
            s.ServiceArn !== undefined,
        );
        if (!summary?.ServiceArn) return undefined;
        return yield* readService(summary.ServiceArn);
      });

      // Create/update/delete are asynchronous; App Runner reports
      // OPERATION_IN_PROGRESS while converging. Service provisioning
      // typically takes 3-5 minutes; budget ~10 min (60 * 10s).
      const waitForSettled = Effect.fn(function* (arn: string) {
        return yield* readService(arn).pipe(
          Effect.flatMap((service) =>
            service !== undefined &&
            statusIs(service.Status, "OPERATION_IN_PROGRESS")
              ? Effect.fail(
                  new AppRunnerServiceNotSettled({
                    serviceArn: arn,
                    status: service.Status,
                  }),
                )
              : Effect.succeed(service),
          ),
          Effect.retry({
            while: (e) => e instanceof AppRunnerServiceNotSettled,
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      // Deletion is asynchronous too; wait until the service is gone so
      // dependencies (auto scaling configurations, VPC connectors) can be
      // deleted right after.
      const waitUntilGone = Effect.fn(function* (arn: string) {
        yield* readService(arn).pipe(
          Effect.flatMap((service) => {
            if (service === undefined) return Effect.void;
            if (statusIs(service.Status, "DELETE_FAILED")) {
              return Effect.fail(
                new Error(
                  `App Runner service '${arn}' failed to delete (status: DELETE_FAILED)`,
                ),
              );
            }
            return Effect.fail(
              new AppRunnerServiceNotSettled({
                serviceArn: arn,
                status: service.Status,
              }),
            );
          }),
          Effect.retry({
            while: (e) => e instanceof AppRunnerServiceNotSettled,
            schedule: Schedule.fixed("10 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
          }),
        );
      });

      const toAttrs = (service: apprunner.Service) => ({
        serviceName: service.ServiceName,
        serviceArn: service.ServiceArn,
        serviceId: service.ServiceId,
        serviceUrl: service.ServiceUrl,
        status: service.Status,
      });

      return {
        stables: ["serviceName", "serviceArn", "serviceId"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // The encryption key is create-only.
          if (
            (news?.kmsKeyArn ?? undefined) !== (olds?.kmsKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const service = output?.serviceArn
            ? yield* readService(output.serviceArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (service === undefined) return undefined;
          const attrs = toAttrs(service);
          const tags = yield* readAppRunnerTags(attrs.serviceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.serviceName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desired = news;

          // 1. Observe — cloud state is authoritative; output is only an
          // identifier cache.
          let observed = output?.serviceArn
            ? yield* readService(output.serviceArn)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            const created = yield* apprunner.createService({
              ServiceName: name,
              SourceConfiguration: toWireSource(desired),
              InstanceConfiguration: toWireInstance(news.instanceConfiguration),
              HealthCheckConfiguration: toWireHealthCheck(
                news.healthCheckConfiguration,
              ),
              NetworkConfiguration: toWireNetwork(news.networkConfiguration),
              AutoScalingConfigurationArn: news.autoScalingConfigurationArn,
              EncryptionConfiguration: news.kmsKeyArn
                ? { KmsKey: news.kmsKeyArn }
                : undefined,
              Tags: toWireTags(desiredTags),
            });
            observed = created.Service;
          }

          // Creation and prior updates run asynchronously — wait (bounded)
          // for the service to settle before mutating it.
          const settled = yield* waitForSettled(observed.ServiceArn);
          if (settled === undefined) {
            return yield* Effect.fail(
              new Error(
                `App Runner service '${name}' disappeared while reconciling`,
              ),
            );
          }
          observed = settled;
          if (statusIs(observed.Status, "CREATE_FAILED")) {
            return yield* Effect.fail(
              new Error(
                `App Runner service '${name}' failed to create (status: CREATE_FAILED). ` +
                  "Check the service's event and application logs in CloudWatch.",
              ),
            );
          }

          // 3. Sync — compare each user-specified aspect against OBSERVED
          // state and send a single updateService with only the drifted
          // groups.
          const update: Omit<apprunner.UpdateServiceRequest, "ServiceArn"> = {};
          if (sourceDrifted(desired, observed.SourceConfiguration)) {
            update.SourceConfiguration = toWireSource(desired);
          }
          if (
            instanceDrifted(
              news.instanceConfiguration,
              observed.InstanceConfiguration,
            )
          ) {
            update.InstanceConfiguration = toWireInstance(
              news.instanceConfiguration,
            );
          }
          if (
            healthCheckDrifted(
              news.healthCheckConfiguration,
              observed.HealthCheckConfiguration,
            )
          ) {
            update.HealthCheckConfiguration = toWireHealthCheck(
              news.healthCheckConfiguration,
            );
          }
          if (
            networkDrifted(
              news.networkConfiguration,
              observed.NetworkConfiguration,
            )
          ) {
            update.NetworkConfiguration = toWireNetwork(
              news.networkConfiguration,
            );
          }
          if (
            news.autoScalingConfigurationArn !== undefined &&
            observed.AutoScalingConfigurationSummary
              ?.AutoScalingConfigurationArn !== news.autoScalingConfigurationArn
          ) {
            update.AutoScalingConfigurationArn =
              news.autoScalingConfigurationArn;
          }

          if (Object.keys(update).length > 0) {
            yield* apprunner.updateService({
              ServiceArn: observed.ServiceArn,
              ...update,
            });
            const updated = yield* waitForSettled(observed.ServiceArn);
            if (updated === undefined) {
              return yield* Effect.fail(
                new Error(
                  `App Runner service '${name}' disappeared while updating`,
                ),
              );
            }
            observed = updated;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAppRunnerTags(observed.ServiceArn, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A service mid-operation rejects deletion with
          // InvalidStateException — wait (bounded) for it to settle first.
          const observed = yield* waitForSettled(output.serviceArn);
          if (observed === undefined) return; // already gone
          yield* apprunner
            .deleteService({ ServiceArn: output.serviceArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // Already deleting — deletion is in progress.
              Effect.catchTag("InvalidStateException", () => Effect.void),
            );
          yield* waitUntilGone(output.serviceArn);
        }),

        list: () =>
          apprunner.listServices.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ServiceSummaryList ?? [])
                .flatMap((s) =>
                  s.Status !== undefined &&
                  !statusIs(s.Status, "DELETED") &&
                  s.ServiceName !== undefined &&
                  s.ServiceArn !== undefined &&
                  s.ServiceId !== undefined
                    ? [
                        {
                          serviceName: s.ServiceName,
                          serviceArn: s.ServiceArn,
                          serviceId: s.ServiceId,
                          serviceUrl: s.ServiceUrl,
                          status: s.Status,
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
