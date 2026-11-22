import { Unowned, Unresolved } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import type * as Effect from "effect/Effect";
import * as EffectMod from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RenderDeployFailedError, RenderNotFoundError, RenderValidationError } from "../Errors.ts";
import type { RenderServiceBinding } from "../RenderBindings.ts";
import type {
  AutoscalingConfig,
  BuildFilter,
  BuildPlan,
  CidrBlockAndDescription,
  CustomDomainInfo,
  DiskAttributes,
  DiskConfig,
  EnvVarValueSpec,
  LogStreamOverrideAttributes,
  LogStreamOverrideInput,
  MaintenanceMode,
  NotificationOverrideConfig,
  PreviewsConfig,
  Region,
  RenderSubdomainPolicy,
  RuntimeSource,
  SecretFileOutput,
  SecretString,
  ServiceType,
} from "../Types.ts";
import * as Client from "./Client.ts";
import { pollUntil } from "./Poll.ts";
import { toRedacted, unwrapSecret } from "./Redacted.ts";
import type {
  WireCustomDomain,
  WireDockerDetails,
  WireEnvVar,
  WireEnvVarInput,
  WireNativeEnvironmentDetails,
  WireNotificationOverride,
  WireResourceLogStreamSetting,
  WireSecretFile,
  WireService,
  WireServiceDetails,
} from "./WireTypes.ts";

export interface BaseServiceProps {
  /** Service name, unique within the Render workspace. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Render project environment ID to associate the service with. */
  environmentId?: string;
  /** Source code or container image configuration (`nativeRuntime`, `docker`, or `image`). */
  runtimeSource: RuntimeSource;
  /** Command to start the service. Required for native runtimes; overrides Docker `CMD` for `docker`/`image`. */
  startCommand?: string;
  /** Repository subdirectory relative to root where Render runs build and start commands. */
  rootDirectory?: string;
  /** Explicit environment variables configured on the service. Bound variables are merged automatically with explicit keys taking precedence. */
  envVars?: Record<string, EnvVarValueSpec>;
  /** Secret files mounted at `/etc/secrets/<name>`. */
  secretFiles?: Record<string, SecretString>;
  /** Deploy notification overrides scoped to this service. */
  notificationOverride?: NotificationOverrideConfig;
  /** Log stream override (`send` or `drop`) scoped to this service. */
  logStreamOverride?: LogStreamOverrideInput;
  /** Build tier (`"starter"` or `"performance"`). */
  buildPlan?: BuildPlan;
  /** Suspend (`true`) or resume (`false`) the running service. */
  suspended?: boolean;
  /** When true, update operations skip triggering a new deploy unless Render already initiates one. */
  skipDeployAfterUpdate?: boolean;
  /** When true, reconcile polls service deploys until the latest deploy reaches `"live"`. */
  waitForDeployCompletion?: boolean;
}

export interface LongRunningServiceProps extends BaseServiceProps {
  /** Deployment region (`oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`). Changing it replaces the service. */
  region?: Region;
  /** Number of running instances for manually scaled services (`1-100`). */
  numInstances?: number;
  /** Autoscaling configuration (paid plans). */
  autoscaling?: AutoscalingConfig;
  /** Optional persistent disk attached to the service. */
  disk?: DiskConfig;
  /** Command run between build and deploy startup (for example database migrations). */
  preDeployCommand?: string;
  /** Maximum seconds Render waits for graceful SIGTERM exit before SIGKILL (`1-300`). */
  maxShutdownDelaySeconds?: number;
  /** Enable legacy pull request previews boolean (prefer `previews.generation`). */
  pullRequestPreviewsEnabled?: boolean;
  /** Pull request preview settings. */
  previews?: PreviewsConfig;
}

export interface ServiceAttributes {
  /** Render service ID (`srv-...`). */
  id: string;
  /** Service name. */
  name: string;
  /** Unique service slug assigned by Render. */
  slug: string;
  /** Workspace/owner ID owning the service. */
  ownerId: string;
  /** Associated Render environment ID, if any. */
  environmentId?: string;
  /** Effective service runtime (`node`, `python`, `docker`, `image`, ...). */
  runtime: string;
  /** Service plan slug. */
  plan?: string;
  /** Deployment region. */
  region?: string;
  /** Build plan used (`starter` or `performance`). */
  buildPlan?: string;
  /** Configured git repository URL, if git-backed. */
  repo?: string;
  /** Configured git branch, if git-backed. */
  branch?: string;
  /** Configured container image path, if image-backed. */
  imagePath?: string;
  /** Configured root directory relative to the repo root. */
  rootDirectory?: string;
  /** Build command (native runtime / static site). */
  buildCommand?: string;
  /** Effective start command or Docker command override. */
  startCommand?: string;
  /** Pre-deploy command, if configured. */
  preDeployCommand?: string;
  /** Auto-deploy boolean reflected by Render (`"yes"` -> `true`). */
  autoDeploy: boolean;
  /** Granular auto-deploy trigger (`"off"`, `"commit"`, or `"checksPass"`). */
  autoDeployTrigger?: string;
  /** Path filters controlling auto-deploys. */
  buildFilter?: BuildFilter;
  /** Registry credential ID used when pulling private Docker/registry images. */
  registryCredentialId?: string;
  /** Render Dashboard URL for this service. */
  dashboardUrl: string;
  /** Service suspension status (`"suspended"` or `"not_suspended"`). */
  suspended: string;
  /** Maximum graceful shutdown delay in seconds. */
  maxShutdownDelaySeconds?: number;
  /** Pull request preview generation settings. */
  previews?: PreviewsConfig;
  /** Redacted environment variables map stored on the service. */
  envVars: Record<string, Redacted.Redacted<string>>;
  /** Redacted secret files stored on the service. */
  secretFiles: SecretFileOutput[];
  /** Attached persistent disk attributes, if any. */
  disk?: DiskAttributes;
  /** Current manual instance count, if reported. */
  numInstances?: number;
  /** Current autoscaling config, if reported. */
  autoscaling?: AutoscalingConfig;
  /** Notification override state. */
  notificationOverride?: {
    notificationsToSend: string;
    previewNotificationsEnabled: string;
  };
  /** Resource log stream override state, if configured. */
  logStreamOverride?: LogStreamOverrideAttributes;
  /** SSH connection address when SSH is enabled. */
  sshAddress?: string;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export const formatImagePath = (source: RuntimeSource): string | undefined => {
  if (!source.image) return undefined;
  const img = source.image;
  if (img.tag && img.tag.length > 0) {
    return `${img.imagePath}:${img.tag}`;
  }
  if (img.digest && img.digest.length > 0) {
    return `${img.imagePath}@${img.digest}`;
  }
  return img.imagePath;
};

export const runtimeOfSource = (source: RuntimeSource): string => {
  if (source.docker) return "docker";
  if (source.image) return "image";
  return source.nativeRuntime.runtime;
};

export const validateRuntimeSource = (source: RuntimeSource, startCommand?: string) => {
  const present = (source.nativeRuntime ? 1 : 0) + (source.docker ? 1 : 0) + (source.image ? 1 : 0);
  if (present !== 1) {
    return EffectMod.fail(
      new RenderValidationError({
        field: "runtimeSource",
        message:
          "Exactly one of runtimeSource.nativeRuntime, runtimeSource.docker, or runtimeSource.image must be set.",
      }),
    );
  }
  if (source.image?.tag && source.image?.digest) {
    return EffectMod.fail(
      new RenderValidationError({
        field: "runtimeSource.image",
        message: "runtimeSource.image.tag and runtimeSource.image.digest are mutually exclusive.",
      }),
    );
  }
  if (source.nativeRuntime && (!startCommand || startCommand.length === 0)) {
    return EffectMod.fail(
      new RenderValidationError({
        field: "startCommand",
        message: "startCommand is required when runtimeSource.nativeRuntime is used.",
      }),
    );
  }
  return EffectMod.void;
};

export const buildEnvSpecificDetailsCreate = (
  source: RuntimeSource,
  startCommand?: string,
): Record<string, unknown> => {
  if (source.docker) {
    return {
      ...(startCommand !== undefined ? { dockerCommand: startCommand } : {}),
      dockerContext: source.docker.context ?? ".",
      dockerfilePath: source.docker.dockerfilePath ?? "./Dockerfile",
      ...(source.docker.registryCredentialId !== undefined
        ? { registryCredentialId: source.docker.registryCredentialId }
        : {}),
    };
  }
  if (source.image) {
    return startCommand !== undefined ? { dockerCommand: startCommand } : {};
  }
  return {
    buildCommand: source.nativeRuntime.buildCommand,
    startCommand: startCommand ?? "",
  };
};

export const buildEnvSpecificDetailsUpdate = (
  source: RuntimeSource,
  startCommand?: string,
): Record<string, unknown> => {
  if (source.docker) {
    return {
      dockerCommand: startCommand ?? "",
      dockerContext: source.docker.context ?? ".",
      dockerfilePath: source.docker.dockerfilePath ?? "./Dockerfile",
      ...(source.docker.registryCredentialId !== undefined
        ? { registryCredentialId: source.docker.registryCredentialId }
        : {}),
    };
  }
  if (source.image) {
    return {
      dockerCommand: startCommand ?? "",
    };
  }
  return {
    buildCommand: source.nativeRuntime.buildCommand,
    ...(startCommand !== undefined ? { startCommand } : {}),
  };
};

const autoDeployFields = (source: {
  autoDeploy?: boolean;
  autoDeployTrigger?: string;
  buildFilter?: BuildFilter;
}) => {
  const fields: Record<string, unknown> = {};
  if (source.autoDeployTrigger !== undefined) {
    fields.autoDeployTrigger = source.autoDeployTrigger;
  } else {
    fields.autoDeploy = source.autoDeploy === false ? "no" : "yes";
  }
  if (source.buildFilter !== undefined) {
    fields.buildFilter = {
      paths: source.buildFilter.paths ?? [],
      ignoredPaths: source.buildFilter.ignoredPaths ?? [],
    };
  }
  return fields;
};

export const buildSourceFieldsCreate = (
  source: RuntimeSource,
  ownerId: string,
): Record<string, unknown> => {
  if (source.nativeRuntime) {
    return {
      repo: source.nativeRuntime.repo,
      branch: source.nativeRuntime.branch,
      ...autoDeployFields(source.nativeRuntime),
    };
  }
  if (source.docker) {
    return {
      repo: source.docker.repo,
      branch: source.docker.branch,
      ...autoDeployFields(source.docker),
    };
  }
  const imagePath = formatImagePath(source) ?? "";
  const imageSource = source.image;
  return {
    image: {
      ownerId,
      imagePath,
      ...(imageSource?.registryCredentialId !== undefined
        ? { registryCredentialId: imageSource.registryCredentialId }
        : {}),
    },
    ...(imageSource &&
    (imageSource.autoDeploy !== undefined || imageSource.autoDeployTrigger !== undefined)
      ? autoDeployFields(imageSource)
      : {}),
  };
};

export const mergeBoundEnvVars = (
  propsEnv: Record<string, EnvVarValueSpec> | undefined,
  bindings: ReadonlyArray<RenderServiceBinding>,
): Record<string, EnvVarValueSpec> => {
  const merged: Record<string, EnvVarValueSpec> = {};
  for (const binding of bindings) {
    if (!binding?.env) continue;
    for (const [k, v] of Object.entries(binding.env)) {
      merged[k] = v;
    }
  }
  if (propsEnv) {
    for (const [k, v] of Object.entries(propsEnv)) {
      merged[k] = v;
    }
  }
  return merged;
};

export const envVarsToWire = (
  envMap: Record<string, EnvVarValueSpec>,
  existingWire: ReadonlyArray<WireEnvVar>,
  preserveGenerated: boolean,
): WireEnvVarInput[] => {
  const existingByKey = new Map(existingWire.map((ev) => [ev.key, ev.value]));
  const result: WireEnvVarInput[] = [];
  for (const [key, spec] of Object.entries(envMap)) {
    if (typeof spec === "object" && spec !== null && "generateValue" in spec) {
      if (spec.generateValue) {
        const existing = existingByKey.get(key);
        if (preserveGenerated && existing !== undefined) {
          result.push({ key, value: existing });
        } else {
          result.push({ key, generateValue: true });
        }
      }
      continue;
    }
    const rawValue =
      typeof spec === "object" && spec !== null && "value" in spec ? spec.value : spec;
    result.push({ key, value: unwrapSecret(rawValue) });
  }
  return result;
};

export const secretFilesToWire = (
  secretFiles: Record<string, SecretString> | undefined,
): WireSecretFile[] => {
  if (!secretFiles) return [];
  return Object.entries(secretFiles).map(([name, content]) => ({
    name,
    content: unwrapSecret(content),
  }));
};

export const syncCustomDomains = (
  serviceId: string,
  existing: ReadonlyArray<WireCustomDomain>,
  desiredNames: ReadonlyArray<string> | undefined,
  verify = false,
) =>
  EffectMod.gen(function* () {
    const desired = new Set(desiredNames ?? []);
    const existingNames = new Set(existing.map((d) => d.name));
    for (const domain of existing) {
      if (!desired.has(domain.name)) {
        yield* Client.deleteCustomDomain(serviceId, domain.id);
      }
    }
    for (const name of desired) {
      if (!existingNames.has(name)) {
        yield* Client.createCustomDomain(serviceId, name);
      }
    }
    if (verify && desired.size > 0) {
      const current = yield* Client.listCustomDomains(serviceId);
      for (const domain of current) {
        if (desired.has(domain.name) && domain.verificationStatus !== "verified") {
          yield* Client.verifyCustomDomain(serviceId, domain.id);
        }
      }
    }
  });

export const syncServiceSuspension = (
  serviceId: string,
  currentSuspended: string,
  desiredSuspended: boolean | undefined,
) => {
  if (desiredSuspended === true && currentSuspended !== "suspended") {
    return Client.suspendService(serviceId);
  }
  if (desiredSuspended === false && currentSuspended === "suspended") {
    return Client.resumeService(serviceId);
  }
  return EffectMod.void;
};

export const syncDisk = (
  serviceId: string,
  current: WireServiceDetails["disk"],
  desired: DiskConfig | undefined,
) =>
  EffectMod.gen(function* () {
    if (!current && !desired) return;
    if (current && !desired) {
      yield* Client.deleteDisk(current.id);
      return;
    }
    if (!current && desired) {
      yield* Client.addDisk({
        serviceId,
        name: desired.name,
        mountPath: desired.mountPath,
        sizeGB: desired.sizeGB ?? 1,
      });
      return;
    }
    if (current && desired) {
      const targetSize = desired.sizeGB ?? current.sizeGB;
      if (
        current.name !== desired.name ||
        current.mountPath !== desired.mountPath ||
        current.sizeGB !== targetSize
      ) {
        yield* Client.updateDisk(current.id, {
          name: desired.name,
          mountPath: desired.mountPath,
          sizeGB: targetSize,
        });
      }
    }
  });

export const syncScalingAndAutoscaling = (
  serviceId: string,
  current: WireServiceDetails,
  desiredAutoscaling: AutoscalingConfig | undefined,
  desiredNumInstances: number | undefined,
) =>
  EffectMod.gen(function* () {
    if (desiredNumInstances !== undefined && desiredNumInstances > 0) {
      if (current.numInstances !== desiredNumInstances) {
        yield* Client.scaleService(serviceId, desiredNumInstances);
      }
    }
    if (!desiredAutoscaling && current.autoscaling) {
      yield* Client.deleteAutoscaling(serviceId);
    } else if (desiredAutoscaling && !deepEqual(current.autoscaling, desiredAutoscaling)) {
      yield* Client.putAutoscaling(serviceId, {
        enabled: desiredAutoscaling.enabled,
        min: desiredAutoscaling.min,
        max: desiredAutoscaling.max,
        criteria: desiredAutoscaling.criteria,
      });
    }
  });

export const syncNotificationOverride = (
  serviceId: string,
  desired: NotificationOverrideConfig | undefined,
  hasCurrent: boolean,
) =>
  EffectMod.gen(function* () {
    if (desired) {
      return yield* Client.patchServiceNotificationOverride(serviceId, {
        notificationsToSend: desired.notificationsToSend ?? "default",
        previewNotificationsEnabled: desired.previewNotificationsEnabled ?? "default",
      });
    }
    if (hasCurrent) {
      return yield* Client.patchServiceNotificationOverride(serviceId, {
        notificationsToSend: "default",
        previewNotificationsEnabled: "default",
      });
    }
    return undefined;
  });

export const syncResourceLogStream = (
  resourceId: string,
  current: WireResourceLogStreamSetting | undefined,
  desired: LogStreamOverrideInput | undefined,
) =>
  EffectMod.gen(function* () {
    if (!desired && !current) return undefined;
    if (!desired && current) {
      yield* Client.deleteResourceLogStream(resourceId);
      return undefined;
    }
    if (desired) {
      return yield* Client.putResourceLogStream(resourceId, {
        setting: desired.setting,
        ...(desired.endpoint !== undefined ? { endpoint: desired.endpoint } : {}),
        ...(desired.token !== undefined ? { token: unwrapSecret(desired.token) } : {}),
      });
    }
    return undefined;
  });

export const waitForServiceLive = (resourceType: string, serviceId: string) =>
  pollUntil({
    operation: "deploy",
    resourceId: serviceId,
    check: Client.listDeploys(serviceId),
    statusOf: (deploys) => deploys[0]?.status,
    failIf: (deploys) => {
      const latest = deploys[0];
      if (!latest?.status) return undefined;
      if (
        latest.status === "build_failed" ||
        latest.status === "canceled" ||
        latest.status === "deactivated" ||
        latest.status === "pre_deploy_failed" ||
        latest.status === "update_failed"
      ) {
        return new RenderDeployFailedError({
          resourceType,
          resourceId: serviceId,
          status: latest.status,
          message: `${resourceType} (${serviceId}) deploy ended with status "${latest.status}"`,
        });
      }
      return undefined;
    },
    isDone: (deploys) => deploys[0]?.status === "live",
  }).pipe(EffectMod.asVoid);

export interface HydratedServiceData {
  readonly service: WireService;
  readonly envVars: WireEnvVar[];
  readonly secretFiles: WireSecretFile[];
  readonly customDomains: WireCustomDomain[];
  readonly notificationOverride?: WireNotificationOverride;
  readonly logStreamOverride?: WireResourceLogStreamSetting;
}

const supportsCustomDomains = (type: ServiceType) =>
  type === "web_service" || type === "static_site";

export const hydrateService = (
  service: WireService,
): Effect.Effect<
  HydratedServiceData,
  Effect.Error<ReturnType<typeof Client.getService>>,
  Effect.Services<ReturnType<typeof Client.getService>>
> =>
  EffectMod.gen(function* () {
    const envVars = yield* Client.listServiceEnvVars(service.id);
    const secretFiles = yield* Client.listServiceSecretFiles(service.id);
    const customDomains = supportsCustomDomains(service.type)
      ? yield* Client.listCustomDomains(service.id)
      : [];
    const notificationOverride = yield* Client.ignoreNotFound(
      Client.getServiceNotificationOverride(service.id),
    );
    const logStreamOverride = yield* Client.ignoreNotFound(Client.getResourceLogStream(service.id));
    return {
      service,
      envVars,
      secretFiles,
      customDomains,
      notificationOverride,
      logStreamOverride,
    };
  });

const extractNativeOrDocker = (details: WireServiceDetails) => {
  const envDetails = details.envSpecificDetails;
  if (!envDetails || typeof envDetails !== "object") {
    return {};
  }
  if ("buildCommand" in envDetails) {
    const nat = envDetails as WireNativeEnvironmentDetails;
    return {
      buildCommand: nat.buildCommand,
      startCommand: nat.startCommand.length > 0 ? nat.startCommand : undefined,
      preDeployCommand:
        nat.preDeployCommand && nat.preDeployCommand.length > 0 ? nat.preDeployCommand : undefined,
    };
  }
  const doc = envDetails as WireDockerDetails;
  return {
    startCommand: doc.dockerCommand && doc.dockerCommand.length > 0 ? doc.dockerCommand : undefined,
    preDeployCommand:
      doc.preDeployCommand && doc.preDeployCommand.length > 0 ? doc.preDeployCommand : undefined,
    registryCredentialId: doc.registryCredential?.id,
  };
};

export const mapBaseServiceAttrs = (data: HydratedServiceData): ServiceAttributes => {
  const s = data.service;
  const d = s.serviceDetails;
  const extracted = extractNativeOrDocker(d);
  const envVarsRecord: Record<string, Redacted.Redacted<string>> = {};
  for (const ev of data.envVars) {
    envVarsRecord[ev.key] = toRedacted(ev.value);
  }
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    ownerId: s.ownerId,
    environmentId: s.environmentId,
    runtime: d.runtime ?? d.env ?? "unknown",
    plan: d.plan,
    region: d.region,
    buildPlan: d.buildPlan,
    repo: s.repo,
    branch: s.branch,
    imagePath: s.imagePath,
    rootDirectory: s.rootDir,
    buildCommand: d.buildCommand ?? extracted.buildCommand,
    startCommand: extracted.startCommand,
    preDeployCommand: extracted.preDeployCommand,
    autoDeploy: s.autoDeploy === "yes",
    autoDeployTrigger: s.autoDeployTrigger,
    buildFilter: s.buildFilter,
    registryCredentialId: s.registryCredential?.id ?? extracted.registryCredentialId,
    dashboardUrl: s.dashboardUrl,
    suspended: s.suspended,
    maxShutdownDelaySeconds: d.maxShutdownDelaySeconds,
    previews: d.previews,
    envVars: envVarsRecord,
    secretFiles: data.secretFiles.map((f) => ({ name: f.name, content: toRedacted(f.content) })),
    disk: d.disk
      ? {
          id: d.disk.id,
          name: d.disk.name,
          mountPath: d.disk.mountPath,
          sizeGB: d.disk.sizeGB,
        }
      : undefined,
    numInstances: d.numInstances,
    autoscaling: d.autoscaling,
    notificationOverride: data.notificationOverride
      ? {
          notificationsToSend: data.notificationOverride.notificationsToSend,
          previewNotificationsEnabled: data.notificationOverride.previewNotificationsEnabled,
        }
      : undefined,
    logStreamOverride: data.logStreamOverride?.setting
      ? {
          resourceId: data.logStreamOverride.resourceId ?? s.id,
          setting: data.logStreamOverride.setting,
          endpoint: data.logStreamOverride.endpoint,
        }
      : undefined,
    sshAddress: d.sshAddress,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
};

export const mapCustomDomains = (domains: ReadonlyArray<WireCustomDomain>): CustomDomainInfo[] =>
  domains.map((d) => ({
    id: d.id,
    name: d.name,
    domainType: d.domainType,
    publicSuffix: d.publicSuffix,
    redirectForName: d.redirectForName,
    verificationStatus: d.verificationStatus,
    server: d.server,
    createdAt: d.createdAt,
  }));

const isEffectResult = <Attrs, E, R>(
  value: Attrs | Effect.Effect<Attrs, E, R>,
): value is Effect.Effect<Attrs, E, R> => EffectMod.isEffect(value);

export const readServiceForProvider = <
  Attrs extends { id: string },
  E = never,
  R = never,
>(options: {
  readonly serviceType: ServiceType;
  readonly id: string;
  readonly olds: { readonly name?: unknown; readonly ownerId?: unknown } | undefined;
  readonly output: { readonly id?: string } | undefined;
  readonly previous?: { readonly id?: string } | undefined;
  readonly toAttributes: (data: HydratedServiceData) => Attrs | Effect.Effect<Attrs, E, R>;
}) =>
  EffectMod.gen(function* () {
    const toAttrsEffect = (hydrated: HydratedServiceData) => {
      const mapped = options.toAttributes(hydrated);
      return isEffectResult(mapped) ? mapped : EffectMod.succeed(mapped);
    };

    if (options.output?.id) {
      const svc = yield* Client.ignoreNotFound(Client.getService(options.output.id));
      if (!svc || svc.type !== options.serviceType) return undefined;
      const hydrated = yield* hydrateService(svc);
      return yield* toAttrsEffect(hydrated);
    }

    const explicitName =
      typeof options.olds?.name === "string" && options.olds.name.length > 0
        ? options.olds.name
        : undefined;
    const explicitOwnerId =
      typeof options.olds?.ownerId === "string" && options.olds.ownerId.length > 0
        ? options.olds.ownerId
        : undefined;
    const desiredName =
      explicitName ?? (yield* createPhysicalName({ id: options.id, maxLength: 64 }));
    const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
    const list = yield* Client.listServices({
      ownerId: [ownerId],
      name: [desiredName],
      type: [options.serviceType],
    });
    const matched = list.find((s) => s.name === desiredName && s.type === options.serviceType);
    if (!matched) return undefined;
    const hydrated = yield* hydrateService(matched);
    const attrs = yield* toAttrsEffect(hydrated);
    return explicitName === undefined || matched.id === options.previous?.id
      ? attrs
      : Unowned(attrs);
  });

export const observeServiceForProvider = (options: {
  readonly serviceType: ServiceType;
  readonly id: string;
  readonly news: { readonly name?: unknown; readonly ownerId?: unknown };
  readonly previous?: { readonly id?: string };
}) =>
  EffectMod.gen(function* () {
    if (!isResolved(options.news.name) || !isResolved(options.news.ownerId)) {
      return Unresolved;
    }
    const explicitName =
      typeof options.news.name === "string" && options.news.name.length > 0
        ? options.news.name
        : undefined;
    const explicitOwnerId =
      typeof options.news.ownerId === "string" && options.news.ownerId.length > 0
        ? options.news.ownerId
        : undefined;
    const desiredName =
      explicitName ?? (yield* createPhysicalName({ id: options.id, maxLength: 64 }));
    const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
    const list = yield* Client.listServices({
      ownerId: [ownerId],
      name: [desiredName],
      type: [options.serviceType],
    });
    const matched = list.find((s) => s.name === desiredName && s.type === options.serviceType);
    if (!matched) return undefined;
    const observed = {
      id: matched.id,
      name: matched.name,
      slug: matched.slug,
    };
    return explicitName === undefined || matched.id === options.previous?.id
      ? observed
      : Unowned(observed);
  });

export const precreateLongRunningService = <
  Props extends LongRunningServiceProps,
  Attrs extends ServiceAttributes,
>(options: {
  readonly resourceType: string;
  readonly serviceType: "web_service" | "private_service" | "background_worker";
  readonly id: string;
  readonly news: Props;
  readonly defaultPlan: string;
  readonly toAttributes: (data: HydratedServiceData) => Attrs;
}) =>
  EffectMod.gen(function* () {
    const { news } = options;
    const rawPlan = "plan" in news ? news.plan : undefined;
    if (
      !isResolved(news.name) ||
      !isResolved(news.ownerId) ||
      !isResolved(news.runtimeSource) ||
      !isResolved(news.region) ||
      !isResolved(rawPlan)
    ) {
      return yield* new RenderValidationError({
        field: "name",
        message:
          `${options.resourceType}(${options.id}): precreate for dependency cycles requires resolved ` +
          "`name`, `ownerId`, `runtimeSource`, `region`, and `plan`.",
      });
    }

    const startCmd =
      typeof news.startCommand === "string"
        ? news.startCommand
        : news.runtimeSource.nativeRuntime
          ? "true"
          : undefined;
    yield* validateRuntimeSource(news.runtimeSource, startCmd);

    const desiredName = news.name ?? (yield* createPhysicalName({ id: options.id, maxLength: 64 }));
    const ownerId = yield* Client.resolveOwnerId(news.ownerId);

    const existingList = yield* Client.listServices({
      ownerId: [ownerId],
      name: [desiredName],
      type: [options.serviceType],
    });
    const existing = existingList.find(
      (s) => s.name === desiredName && s.type === options.serviceType,
    );
    if (existing) {
      return options.toAttributes(yield* hydrateService(existing));
    }

    const plan = typeof rawPlan === "string" ? rawPlan : options.defaultPlan;
    const runtime = runtimeOfSource(news.runtimeSource);
    const sourceFields = buildSourceFieldsCreate(news.runtimeSource, ownerId);
    const createdRes = yield* Client.createService({
      name: desiredName,
      ownerId,
      type: options.serviceType,
      ...sourceFields,
      autoDeploy: "no",
      serviceDetails: {
        runtime,
        plan,
        ...(news.buildPlan !== undefined && isResolved(news.buildPlan)
          ? { buildPlan: news.buildPlan }
          : {}),
        ...(news.region !== undefined ? { region: news.region } : {}),
        numInstances: isResolved(news.numInstances) ? (news.numInstances ?? 1) : 1,
        envSpecificDetails: buildEnvSpecificDetailsCreate(news.runtimeSource, startCmd),
      },
    });

    const service = createdRes.service
      ? createdRes.service
      : yield* Client.listServices({
          ownerId: [ownerId],
          name: [desiredName],
          type: [options.serviceType],
        }).pipe(EffectMod.map((rows) => rows.find((s) => s.name === desiredName)));

    if (!service) {
      return yield* new RenderNotFoundError({
        status: 404,
        method: "POST",
        path: "/services",
        message: `Render precreated service "${desiredName}" was not returned after creation.`,
      });
    }

    const fresh = yield* Client.getService(service.id);
    return options.toAttributes(yield* hydrateService(fresh));
  });

export const findServiceByLookup = (
  serviceType: ServiceType,
  props: { id?: string; name?: string; ownerId?: string },
) =>
  EffectMod.gen(function* () {
    if (props.id) {
      const svc = yield* Client.ignoreNotFound(Client.getService(props.id));
      if (!svc || svc.type !== serviceType) return undefined;
      return yield* hydrateService(svc);
    }
    if (!props.name) return undefined;
    const ownerId = yield* Client.resolveOwnerId(props.ownerId);
    const list = yield* Client.listServices({
      ownerId: [ownerId],
      name: [props.name],
      type: [serviceType],
    });
    const matched = list.find((s) => s.name === props.name && s.type === serviceType);
    if (!matched) return undefined;
    return yield* hydrateService(matched);
  });

export const listServicesByType = (serviceType: ServiceType) =>
  EffectMod.gen(function* () {
    const ownerId = yield* Client.resolveOwnerId();
    const list = yield* Client.listServices({ ownerId: [ownerId], type: [serviceType] });
    return yield* EffectMod.forEach(list, hydrateService);
  });

export const buildIpAllowListField = (
  newsList: CidrBlockAndDescription[] | undefined,
  oldsList: CidrBlockAndDescription[] | undefined,
): CidrBlockAndDescription[] | undefined => {
  if (newsList !== undefined) return newsList;
  if (oldsList !== undefined) {
    return [{ cidrBlock: "0.0.0.0/0", description: "everywhere" }];
  }
  return undefined;
};

export const pickMaintenanceMode = (
  news: MaintenanceMode | undefined,
  olds: MaintenanceMode | undefined,
) => {
  if (news !== undefined) {
    return { enabled: news.enabled ?? false, uri: news.uri ?? "" };
  }
  if (olds !== undefined) {
    return { enabled: false, uri: "" };
  }
  return undefined;
};

export const pickRenderSubdomainPolicy = (
  news: RenderSubdomainPolicy | undefined,
): RenderSubdomainPolicy | undefined => news;

export const pickPreviews = (news: LongRunningServiceProps) => {
  if (news.previews !== undefined) {
    return { generation: news.previews.generation ?? "off" };
  }
  if (news.pullRequestPreviewsEnabled !== undefined) {
    return undefined;
  }
  return undefined;
};

/**
 * Shared reconciler for long-running compute services (`WebService`,
 * `PrivateService`, `BackgroundWorker`) covering Observe -> Ensure -> Sync.
 */
export const reconcileLongRunningService = <
  Props extends LongRunningServiceProps,
  Attrs extends ServiceAttributes,
>(options: {
  readonly resourceType: string;
  readonly serviceType: "web_service" | "private_service" | "background_worker";
  readonly id: string;
  readonly news: Props;
  readonly olds: Props | undefined;
  readonly output: Attrs | undefined;
  readonly desiredName: string;
  readonly bindings: ReadonlyArray<RenderServiceBinding>;
  readonly defaultPlan: string;
  readonly extraCreateDetails: (news: Props, olds: Props | undefined) => Record<string, unknown>;
  readonly extraUpdateDetails: (news: Props, olds: Props | undefined) => Record<string, unknown>;
  readonly extraDesiredCustomDomains?: (news: Props) => ReadonlyArray<string> | undefined;
  readonly extraVerifyCustomDomains?: (news: Props) => boolean | undefined;
  readonly toAttributes: (data: HydratedServiceData) => Attrs;
}) =>
  EffectMod.gen(function* () {
    const { news, olds, output } = options;
    yield* validateRuntimeSource(news.runtimeSource, news.startCommand);

    const existing = output?.id
      ? yield* Client.ignoreNotFound(Client.getService(output.id))
      : undefined;

    const mergedEnv = mergeBoundEnvVars(news.envVars, options.bindings);
    const runtime = runtimeOfSource(news.runtimeSource);

    if (!existing) {
      const ownerId = yield* Client.resolveOwnerId(news.ownerId);
      const envVarsWire = envVarsToWire(mergedEnv, [], false);
      const secretFilesWire = secretFilesToWire(news.secretFiles);
      const serviceDetails: Record<string, unknown> = {
        runtime,
        plan:
          ("plan" in news && typeof news.plan === "string" ? news.plan : undefined) ??
          options.defaultPlan,
        ...(news.buildPlan !== undefined ? { buildPlan: news.buildPlan } : {}),
        ...(news.region !== undefined ? { region: news.region } : {}),
        numInstances: news.numInstances ?? 1,
        envSpecificDetails: buildEnvSpecificDetailsCreate(news.runtimeSource, news.startCommand),
        ...(news.autoscaling !== undefined ? { autoscaling: news.autoscaling } : {}),
        ...(news.disk !== undefined
          ? {
              disk: {
                name: news.disk.name,
                mountPath: news.disk.mountPath,
                sizeGB: news.disk.sizeGB ?? 1,
              },
            }
          : {}),
        ...(news.preDeployCommand !== undefined ? { preDeployCommand: news.preDeployCommand } : {}),
        ...(news.maxShutdownDelaySeconds !== undefined
          ? { maxShutdownDelaySeconds: news.maxShutdownDelaySeconds }
          : {}),
        ...(pickPreviews(news) !== undefined ? { previews: pickPreviews(news) } : {}),
        ...(news.pullRequestPreviewsEnabled !== undefined
          ? { pullRequestPreviewsEnabled: news.pullRequestPreviewsEnabled ? "yes" : "no" }
          : {}),
        ...options.extraCreateDetails(news, olds),
      };

      const createdRes = yield* Client.createService({
        name: options.desiredName,
        ownerId,
        type: options.serviceType,
        ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
        ...(envVarsWire.length > 0 ? { envVars: envVarsWire } : {}),
        ...(secretFilesWire.length > 0 ? { secretFiles: secretFilesWire } : {}),
        serviceDetails,
        ...buildSourceFieldsCreate(news.runtimeSource, ownerId),
      });

      const service = createdRes.service
        ? createdRes.service
        : yield* Client.listServices({
            ownerId: [ownerId],
            name: [options.desiredName],
            type: [options.serviceType],
          }).pipe(EffectMod.map((rows) => rows[0]));

      if (!service) {
        return yield* new RenderNotFoundError({
          status: 404,
          method: "POST",
          path: "/services",
          message: `Render service "${options.desiredName}" was not returned after creation.`,
        });
      }

      if (news.environmentId !== undefined) {
        yield* Client.syncResourceEnvironment(
          service.id,
          service.environmentId,
          news.environmentId,
        );
      }

      if (options.extraDesiredCustomDomains) {
        const desiredDomains = options.extraDesiredCustomDomains(news);
        if (desiredDomains && desiredDomains.length > 0) {
          yield* syncCustomDomains(
            service.id,
            [],
            desiredDomains,
            options.extraVerifyCustomDomains?.(news),
          );
        }
      }

      if (news.notificationOverride) {
        yield* syncNotificationOverride(service.id, news.notificationOverride, false);
      }
      if (news.logStreamOverride) {
        yield* syncResourceLogStream(service.id, undefined, news.logStreamOverride);
      }

      yield* syncServiceSuspension(service.id, service.suspended, news.suspended);

      if (news.waitForDeployCompletion) {
        yield* waitForServiceLive(options.resourceType, service.id);
      }

      const fresh = yield* Client.getService(service.id);
      const hydrated = yield* hydrateService(fresh);
      return options.toAttributes(hydrated);
    }

    const hydratedBefore = yield* hydrateService(existing);
    yield* syncScalingAndAutoscaling(
      existing.id,
      existing.serviceDetails,
      news.autoscaling,
      news.numInstances,
    );

    const updateDetails: Record<string, unknown> = {
      runtime,
      plan:
        ("plan" in news && typeof news.plan === "string" ? news.plan : undefined) ??
        options.defaultPlan,
      ...(news.buildPlan !== undefined ? { buildPlan: news.buildPlan } : {}),
      envSpecificDetails: buildEnvSpecificDetailsUpdate(news.runtimeSource, news.startCommand),
      preDeployCommand: news.preDeployCommand ?? "",
      ...(news.maxShutdownDelaySeconds !== undefined
        ? { maxShutdownDelaySeconds: news.maxShutdownDelaySeconds }
        : {}),
      ...(pickPreviews(news) !== undefined ? { previews: pickPreviews(news) } : {}),
      ...(news.pullRequestPreviewsEnabled !== undefined
        ? { pullRequestPreviewsEnabled: news.pullRequestPreviewsEnabled ? "yes" : "no" }
        : {}),
      ...options.extraUpdateDetails(news, olds),
    };

    yield* Client.updateService(existing.id, {
      name: options.desiredName,
      ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
      serviceDetails: updateDetails,
      ...buildSourceFieldsCreate(news.runtimeSource, existing.ownerId),
    });

    const desiredEnvWire = envVarsToWire(mergedEnv, hydratedBefore.envVars, true);
    yield* Client.putServiceEnvVars(existing.id, desiredEnvWire);

    const desiredFilesWire = secretFilesToWire(news.secretFiles);
    yield* Client.putServiceSecretFiles(existing.id, desiredFilesWire);

    yield* syncDisk(existing.id, existing.serviceDetails.disk, news.disk);
    yield* syncNotificationOverride(
      existing.id,
      news.notificationOverride,
      hydratedBefore.notificationOverride !== undefined,
    );
    yield* syncResourceLogStream(
      existing.id,
      hydratedBefore.logStreamOverride,
      news.logStreamOverride,
    );
    yield* Client.syncResourceEnvironment(existing.id, existing.environmentId, news.environmentId);

    if (options.extraDesiredCustomDomains) {
      yield* syncCustomDomains(
        existing.id,
        hydratedBefore.customDomains,
        options.extraDesiredCustomDomains(news),
        options.extraVerifyCustomDomains?.(news),
      );
    }

    yield* syncServiceSuspension(existing.id, existing.suspended, news.suspended);

    if (!news.skipDeployAfterUpdate) {
      yield* Client.createDeploy(existing.id);
    }

    if (news.waitForDeployCompletion) {
      yield* waitForServiceLive(options.resourceType, existing.id);
    }

    const refreshed = yield* Client.getService(existing.id);
    const hydratedAfter = yield* hydrateService(refreshed);
    return options.toAttributes(hydratedAfter);
  });
