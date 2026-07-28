import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { Docker, dockerPhysicalName } from "alchemy/Docker";
import * as Provider from "alchemy/Provider";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Context } from "./Context.ts";
import type { Providers } from "./Providers.ts";

export interface ServiceProps {
  /** Service name. Defaults to generated physical name. */
  name?: string;
  /** Docker context resource for this service. Overrides global context when set. */
  context?: Context;
  /** Docker image reference or Docker image resource. */
  image: Service.Image;
  /** Entrypoint command passed after the image. */
  command?: string[];
  /** Additional args appended after `command`. */
  args?: string[];
  /** Environment variables (supports Redacted). */
  environment?: Record<string, string | Redacted.Redacted<string>>;
  /** Overlay networks attached to this service. */
  networks?: Array<string | Service.NetworkAttachment>;
  /** Published port mappings. */
  ports?: Service.PortMapping[];
  /** Service discovery endpoint mode. @default "vip" */
  endpointMode?: "vip" | "dnsrr";
  /** Desired number of service replicas. @default 1 */
  replicas?: number;
  /** Placement controls for task scheduling. */
  placement?: Service.Placement;
  /** Deprecated alias for `placement.constraints`. */
  constraints?: string[];
  /** Rolling update strategy for service updates. */
  updateConfig?: Service.RolloutConfig;
  /** Rollback strategy applied when updates fail. */
  rollbackConfig?: Service.RolloutConfig;
  /** Task restart behavior. */
  restartPolicy?: Service.RestartPolicy;
  /** Container healthcheck for service tasks. */
  healthcheck?: Service.Healthcheck;
  /** Grace period before force-killing a task during shutdown, e.g. "30s". */
  stopGracePeriod?: string;
  /** Volume or bind mounts. */
  volumes?: Service.VolumeMapping[];
  /** Swarm secrets mounted into task containers. */
  secrets?: Service.SecretRef[];
  /** Swarm configs mounted into task containers. */
  configs?: Service.ConfigRef[];
  /** Mount task root filesystem read-only. */
  readOnlyRootFs?: boolean;
  /** Service labels. */
  labels?: Record<string, string>;
}

export declare namespace Service {
  type Image = string | { imageRef: string };

  interface PortMapping {
    /** Published port on the swarm node. Omit to let Swarm assign one dynamically. */
    external?: number;
    internal: number;
    protocol?: "tcp" | "udp";
    mode?: "ingress" | "host";
  }

  interface VolumeMapping {
    /** Host path or named volume source. */
    hostPath: string;
    /** Container path. */
    containerPath: string;
    /** Mount read-only. @default false */
    readOnly?: boolean;
  }

  interface NetworkAttachment {
    name: string;
    aliases?: string[];
  }

  interface Placement {
    constraints?: string[];
    preferences?: string[];
    maxReplicasPerNode?: number;
  }

  interface RolloutConfig {
    parallelism?: number;
    delay?: string;
    monitor?: string;
    failureAction?: "pause" | "continue" | "rollback";
    maxFailureRatio?: number;
    order?: "stop-first" | "start-first";
  }

  interface RestartPolicy {
    condition?: "none" | "on-failure" | "any";
    delay?: string;
    maxAttempts?: number;
    window?: string;
  }

  interface Healthcheck {
    cmd: string[] | string;
    interval?: string;
    timeout?: string;
    retries?: number;
    startPeriod?: string;
  }

  interface SecretRef {
    source: string;
    target?: string;
    uid?: string;
    gid?: string;
    mode?: number | string;
  }

  interface ConfigRef {
    source: string;
    target?: string;
    uid?: string;
    gid?: string;
    mode?: number | string;
  }
}

export interface Service extends Resource<
  "Docker.Service",
  ServiceProps,
  {
    id: string;
    name: string;
    context?: string;
    image: string;
    replicas: number;
    networks: string[];
    ports: Service.PortMapping[];
    labels: Record<string, string>;
    endpointMode: "vip" | "dnsrr";
    createdAt: number;
    updatedAt: number;
  },
  never,
  Providers
> {}

type ServiceInspect = {
  ID: string;
  CreatedAt?: string;
  UpdatedAt?: string;
  Spec: {
    Name: string;
    Labels?: Record<string, string> | null;
    TaskTemplate?: {
      ContainerSpec?: {
        Image?: string;
      };
      Networks?: Array<{ Target?: string }>;
      Placement?: {
        Constraints?: string[];
      };
    };
    Mode?: {
      Replicated?: {
        Replicas?: number;
      };
      Global?: Record<string, never>;
    };
    EndpointSpec?: {
      Mode?: "vip" | "dnsrr";
      Ports?: Array<{
        PublishedPort?: number;
        TargetPort?: number;
        Protocol?: "tcp" | "udp";
        PublishMode?: "ingress" | "host";
      }>;
    };
  };
};

export const Service = Resource<Service>("Docker.Service");

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const docker = yield* Docker;

      const inspect = (id: string, context?: string) =>
        docker.service.inspect(id, context).pipe(
          Effect.map((result) => normalizeServiceInspect(result)),
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.undefined,
          ),
        );

      return Service.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const context = normalizeContext(olds.context);
          const live = yield* inspect(name, context);
          if (!live) return undefined;
          ensureReplicatedMode(live);
          const attrs = toServiceAttributes(live, context);
          if (output) return attrs;
          const owned = yield* hasAlchemyTags(
            id,
            live.Spec.Labels ?? undefined,
          );
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds }) {
          if (!isResolved(news)) return undefined;

          const oldDesired = yield* normalizeDesired(id, olds, instanceId);
          const newDesired = yield* normalizeDesired(id, news, instanceId);

          if (!Equal.equals(oldDesired, newDesired)) {
            return { action: "replace" as const, deleteFirst: true };
          }

          return { action: "noop" as const };
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          olds,
          output,
        }) {
          const desired = yield* normalizeDesired(id, news, instanceId);

          if (output && olds) {
            const oldDesired = yield* normalizeDesired(id, olds, instanceId);
            if (deepEqual(oldDesired, desired)) {
              const current = yield* inspect(output.id, desired.context);
              if (current) {
                ensureReplicatedMode(current);
                return toServiceAttributes(current, desired.context);
              }
            }
          }

          if (output) {
            const current = yield* inspect(output.id, desired.context);
            if (current) {
              ensureReplicatedMode(current);
              const internalTags = yield* createInternalTags(id);
              const allDesiredLabels = { ...internalTags, ...desired.labels };
              const currentLabels = current.Spec.Labels ?? {};
              const labelsToRemove = Object.keys(currentLabels).filter(
                (k) => !(k in allDesiredLabels),
              );
              yield* docker.service.update({
                context: desired.context,
                id: output.id,
                image: desired.image,
                replicas: desired.replicas,
                "endpoint-mode": desired.endpointMode,
                "constraint-add": desired.constraints,
                "replicas-max-per-node": desired.maxReplicasPerNode,
                "placement-pref": desired.preferences,
                "update-parallelism": desired.updateConfig?.parallelism,
                "update-delay": desired.updateConfig?.delay,
                "update-monitor": desired.updateConfig?.monitor,
                "update-failure-action": desired.updateConfig?.failureAction,
                "update-max-failure-ratio":
                  desired.updateConfig?.maxFailureRatio,
                "update-order": desired.updateConfig?.order,
                "rollback-parallelism": desired.rollbackConfig?.parallelism,
                "rollback-delay": desired.rollbackConfig?.delay,
                "rollback-monitor": desired.rollbackConfig?.monitor,
                "rollback-failure-action":
                  desired.rollbackConfig?.failureAction,
                "rollback-max-failure-ratio":
                  desired.rollbackConfig?.maxFailureRatio,
                "rollback-order": desired.rollbackConfig?.order,
                "restart-condition": desired.restartPolicy?.condition,
                "restart-delay": desired.restartPolicy?.delay,
                "restart-max-attempts": desired.restartPolicy?.maxAttempts,
                "restart-window": desired.restartPolicy?.window,
                "health-cmd": desired.healthcheck
                  ? Array.isArray(desired.healthcheck.cmd)
                    ? desired.healthcheck.cmd.join(" ")
                    : desired.healthcheck.cmd
                  : undefined,
                "health-interval": desired.healthcheck?.interval,
                "health-timeout": desired.healthcheck?.timeout,
                "health-retries": desired.healthcheck?.retries,
                "health-start-period": desired.healthcheck?.startPeriod,
                "stop-grace-period": desired.stopGracePeriod,
                "mount-add": desired.volumes.map((v) =>
                  [
                    `type=${/^(\/|\.\.\/|\.\.\/|~)/.test(v.hostPath) ? "bind" : "volume"}`,
                    `source=${v.hostPath}`,
                    `target=${v.containerPath}`,
                    ...(v.readOnly ? ["readonly=true"] : []),
                  ].join(","),
                ),
                "secret-add": desired.secrets.map((s) =>
                  Object.entries(s)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(","),
                ),
                "config-add": desired.configs.map((c) =>
                  Object.entries(c)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(","),
                ),
                "read-only": desired.readOnlyRootFs || undefined,
                "publish-add": desired.ports.map((p) =>
                  [
                    ...(p.external !== undefined
                      ? [`published=${p.external}`]
                      : []),
                    `target=${p.internal}`,
                    `protocol=${p.protocol ?? "tcp"}`,
                    `mode=${p.mode ?? "ingress"}`,
                  ].join(","),
                ),
                "label-add": allDesiredLabels,
                "label-rm": labelsToRemove,
                "env-add": desired.environment,
                args:
                  desired.command.length > 0
                    ? desired.command.concat(desired.args).join(" ")
                    : undefined,
              });

              return toServiceAttributes(
                yield* inspectOrDie(inspect, output.id, desired.context),
                desired.context,
              );
            }
          }

          const existingByName = yield* inspect(desired.name, desired.context);
          if (existingByName) {
            ensureReplicatedMode(existingByName);
            return toServiceAttributes(existingByName, desired.context);
          }

          const internalTags = yield* createInternalTags(id);
          const allDesiredLabels = { ...internalTags, ...desired.labels };
          yield* docker.service.create({
            context: desired.context,
            name: desired.name,
            image: desired.image,
            replicas: desired.replicas,
            "endpoint-mode": desired.endpointMode,
            network: desired.networks.map((n) =>
              [
                `name=${n.name}`,
                ...(n.aliases ?? []).map((a) => `alias=${a}`),
              ].join(","),
            ),
            constraint: desired.constraints,
            "replicas-max-per-node": desired.maxReplicasPerNode,
            "placement-pref": desired.preferences,
            "update-parallelism": desired.updateConfig?.parallelism,
            "update-delay": desired.updateConfig?.delay,
            "update-monitor": desired.updateConfig?.monitor,
            "update-failure-action": desired.updateConfig?.failureAction,
            "update-max-failure-ratio": desired.updateConfig?.maxFailureRatio,
            "update-order": desired.updateConfig?.order,
            "rollback-parallelism": desired.rollbackConfig?.parallelism,
            "rollback-delay": desired.rollbackConfig?.delay,
            "rollback-monitor": desired.rollbackConfig?.monitor,
            "rollback-failure-action": desired.rollbackConfig?.failureAction,
            "rollback-max-failure-ratio":
              desired.rollbackConfig?.maxFailureRatio,
            "rollback-order": desired.rollbackConfig?.order,
            "restart-condition": desired.restartPolicy?.condition,
            "restart-delay": desired.restartPolicy?.delay,
            "restart-max-attempts": desired.restartPolicy?.maxAttempts,
            "restart-window": desired.restartPolicy?.window,
            "health-cmd": desired.healthcheck
              ? Array.isArray(desired.healthcheck.cmd)
                ? desired.healthcheck.cmd.join(" ")
                : desired.healthcheck.cmd
              : undefined,
            "health-interval": desired.healthcheck?.interval,
            "health-timeout": desired.healthcheck?.timeout,
            "health-retries": desired.healthcheck?.retries,
            "health-start-period": desired.healthcheck?.startPeriod,
            "stop-grace-period": desired.stopGracePeriod,
            mount: desired.volumes.map((v) =>
              [
                `type=${/^(\/|\.\.\/|\.\.\/|~)/.test(v.hostPath) ? "bind" : "volume"}`,
                `source=${v.hostPath}`,
                `target=${v.containerPath}`,
                ...(v.readOnly ? ["readonly=true"] : []),
              ].join(","),
            ),
            secret: desired.secrets.map((s) =>
              Object.entries(s)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${v}`)
                .join(","),
            ),
            config: desired.configs.map((c) =>
              Object.entries(c)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${v}`)
                .join(","),
            ),
            "read-only": desired.readOnlyRootFs || undefined,
            publish: desired.ports.map((p) =>
              [
                ...(p.external !== undefined
                  ? [`published=${p.external}`]
                  : []),
                `target=${p.internal}`,
                `protocol=${p.protocol ?? "tcp"}`,
                `mode=${p.mode ?? "ingress"}`,
              ].join(","),
            ),
            label: allDesiredLabels,
            env: desired.environment,
            command: desired.command,
            args: desired.args,
          });
          return toServiceAttributes(
            yield* inspectOrDie(inspect, desired.name, desired.context),
            desired.context,
          );
        }),
        delete: Effect.fn(({ output }) =>
          docker
            .run([
              ...(output.context ? ["--context", output.context] : []),
              "service",
              "scale",
              "--detach=false",
              `${output.id}=0`,
            ])
            .pipe(
              Effect.flatMap(() =>
                docker.service.remove(output.id, output.context),
              ),
              Effect.flatMap(() =>
                waitForServiceContainersReleased(
                  docker,
                  output.id,
                  output.context,
                ),
              ),
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

const normalizeDesired = (
  id: string,
  props: ServiceProps,
  instanceId: string,
) =>
  dockerPhysicalName(id, props, instanceId).pipe(
    Effect.map((name) => ({
      name,
      context: normalizeContext(props.context),
      image: normalizeImageRef(props.image),
      command: props.command ?? [],
      args: props.args ?? [],
      environment: normalizeEnvironment(props.environment),
      networks: normalizeNetworks(props.networks),
      ports: normalizePorts(props.ports),
      endpointMode: props.endpointMode ?? "vip",
      replicas: normalizeReplicas(props.replicas),
      constraints: [
        ...(props.constraints ?? []),
        ...(props.placement?.constraints ?? []),
      ],
      maxReplicasPerNode: props.placement?.maxReplicasPerNode,
      preferences: props.placement?.preferences ?? [],
      updateConfig: props.updateConfig,
      rollbackConfig: props.rollbackConfig,
      restartPolicy: props.restartPolicy,
      healthcheck: props.healthcheck,
      stopGracePeriod: props.stopGracePeriod,
      volumes: normalizeVolumes(props.volumes),
      secrets: props.secrets ?? [],
      configs: props.configs ?? [],
      readOnlyRootFs: props.readOnlyRootFs ?? false,
      labels: props.labels ?? {},
    })),
  );

const normalizeImageRef = (image: Service.Image): string =>
  typeof image === "string" ? image : (image as { imageRef: string }).imageRef;

const normalizeContext = (
  context: Context | string | undefined,
): string | undefined => {
  const value =
    typeof context === "string"
      ? context.trim()
      : (() => {
          const name = (context as { name?: unknown } | undefined)?.name;
          return typeof name === "string" ? name.trim() : undefined;
        })();
  return value && value.length > 0 ? value : undefined;
};

const normalizeEnvironment = (
  environment: Record<string, string | Redacted.Redacted<string>> | undefined,
) =>
  Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

const normalizePorts = (
  ports: Service.PortMapping[] | undefined,
): Service.PortMapping[] =>
  (ports ?? []).map((port) => ({
    external: port.external,
    internal: port.internal,
    protocol: port.protocol ?? "tcp",
    mode: port.mode ?? "ingress",
  }));

const normalizeReplicas = (replicas: number | undefined): number => {
  const value = replicas ?? 1;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Service.replicas must be an integer >= 0");
  }
  return value;
};

const normalizeVolumes = (
  volumes: Service.VolumeMapping[] | undefined,
): Service.VolumeMapping[] => volumes ?? [];

const normalizeNetworks = (
  networks: Array<string | Service.NetworkAttachment> | undefined,
): Service.NetworkAttachment[] =>
  (networks ?? []).map((network) =>
    typeof network === "string" ? { name: network } : network,
  );

const toServiceAttributes = (
  service: ServiceInspect,
  context?: string,
): Service["Attributes"] => {
  return {
    id: service.ID,
    name: service.Spec.Name,
    context,
    image: service.Spec.TaskTemplate?.ContainerSpec?.Image ?? "",
    replicas: service.Spec.Mode?.Replicated?.Replicas ?? 1,
    networks: (service.Spec.TaskTemplate?.Networks ?? []).flatMap((n) =>
      n.Target ? [n.Target] : [],
    ),
    ports: (service.Spec.EndpointSpec?.Ports ?? []).flatMap((port) => {
      if (port.PublishedPort === undefined || port.TargetPort === undefined) {
        return [];
      }
      return [
        {
          external: port.PublishedPort,
          internal: port.TargetPort,
          protocol: port.Protocol ?? "tcp",
          mode: port.PublishMode ?? "ingress",
        },
      ];
    }),
    labels: service.Spec.Labels ?? {},
    endpointMode: service.Spec.EndpointSpec?.Mode ?? "vip",
    createdAt: Date.parse(service.CreatedAt ?? "") || Date.now(),
    updatedAt: Date.parse(service.UpdatedAt ?? "") || Date.now(),
  };
};

const ensureReplicatedMode = (service: ServiceInspect): void => {
  if (service.Spec.Mode?.Global !== undefined) {
    throw new Error(
      `Docker.Service only supports replicated services. Service "${service.Spec.Name}" is global.`,
    );
  }
};

const parseInspectArray = <T>(json: string): T => {
  const parsed = JSON.parse(json) as T[];
  if (parsed.length === 0) {
    throw new Error("docker inspect returned no objects");
  }
  return parsed[0]!;
};

const normalizeServiceInspect = (value: unknown): ServiceInspect => {
  if (typeof value === "object" && value !== null && "stdout" in value) {
    const stdout = (value as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") {
      return parseInspectArray<ServiceInspect>(stdout);
    }
  }
  return value as ServiceInspect;
};

const inspectOrDie = <T>(
  inspect: (
    nameOrId: string,
    context?: string,
  ) => Effect.Effect<T | undefined, any>,
  nameOrId: string,
  context?: string,
) =>
  inspect(nameOrId, context).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.die(`Expected ${nameOrId} to exist after create`),
    ),
  );

const waitForServiceContainersReleased = (
  docker: Docker["Service"],
  serviceId: string,
  context?: string,
): Effect.Effect<void, any, any> => {
  const maxAttempts = 10;
  const noContainers = Symbol.for("Docker.Service.NoContainers");

  const poll = listServiceContainerIds(docker, serviceId, context).pipe(
    Effect.flatMap((containerIds) =>
      containerIds.length === 0
        ? Effect.fail(noContainers)
        : Effect.succeed(containerIds),
    ),
  );

  return poll.pipe(
    Effect.repeat(
      Schedule.spaced("1 second").pipe(
        Schedule.upTo({ times: maxAttempts - 1 }),
      ),
    ),
    Effect.catchIf(
      (error): error is typeof noContainers => error === noContainers,
      () => Effect.void,
    ),
    Effect.andThen(listServiceContainerIds(docker, serviceId, context)),
    Effect.flatMap((containerIds) =>
      containerIds.length === 0
        ? Effect.void
        : // Best effort cleanup for lingering task containers that keep volumes attached.
          Effect.forEach(
            containerIds,
            (containerId) =>
              docker
                .run([
                  ...(context ? ["--context", context] : []),
                  "container",
                  "rm",
                  "-f",
                  containerId,
                ])
                .pipe(Effect.catchCause(() => Effect.void)),
            { concurrency: "unbounded" },
          ).pipe(Effect.as(undefined)),
    ),
  );
};

const listServiceContainerIds = (
  docker: Docker["Service"],
  serviceId: string,
  context?: string,
): Effect.Effect<string[], any, any> =>
  docker
    .run([
      ...(context ? ["--context", context] : []),
      "ps",
      "-a",
      "--filter",
      `label=com.docker.swarm.service.id=${serviceId}`,
      "--format",
      "{{.ID}}",
    ])
    .pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );
