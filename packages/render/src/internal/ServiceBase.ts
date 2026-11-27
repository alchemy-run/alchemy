import * as RenderSdk from "@distilled.cloud/render";
import { Unowned, Unresolved } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import type * as Effect from "effect/Effect";
import * as EffectMod from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RenderDeployFailedError, RenderValidationError } from "../Errors.ts";
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
import * as Api from "./Api.ts";
import { pollUntil } from "./Poll.ts";
import { toRedacted, unwrapSecret } from "./Redacted.ts";

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
): RenderSdk.EnvSpecificDetailsPOST => {
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

/**
 * `@distilled.cloud/render` `CronJobDetailsPOST` types `envSpecificDetails` with
 * the response union `EnvSpecificDetails`; this builds compatible details cleanly.
 */
export const buildCronEnvSpecificDetailsCreate = (
  source: RuntimeSource,
  startCommand?: string,
): RenderSdk.EnvSpecificDetails => {
  if (source.docker) {
    return {
      dockerCommand: startCommand ?? "",
      dockerContext: source.docker.context ?? ".",
      dockerfilePath: source.docker.dockerfilePath ?? "./Dockerfile",
    };
  }
  if (source.image) {
    return {
      dockerCommand: startCommand ?? "",
      dockerContext: ".",
      dockerfilePath: "./Dockerfile",
    };
  }
  return {
    buildCommand: source.nativeRuntime.buildCommand,
    startCommand: startCommand ?? "",
  };
};

export const buildEnvSpecificDetailsUpdate = (
  source: RuntimeSource,
  startCommand?: string,
): RenderSdk.EnvSpecificDetailsPATCH => {
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
}) => ({
  ...(source.autoDeployTrigger !== undefined
    ? { autoDeployTrigger: source.autoDeployTrigger }
    : { autoDeploy: source.autoDeploy === false ? ("no" as const) : ("yes" as const) }),
  ...(source.buildFilter !== undefined
    ? {
        buildFilter: {
          paths: source.buildFilter.paths ?? [],
          ignoredPaths: source.buildFilter.ignoredPaths ?? [],
        },
      }
    : {}),
});

export const buildSourceFieldsCreate = (source: RuntimeSource, ownerId: string) => {
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
  existingWire: ReadonlyArray<RenderSdk.EnvVar>,
  preserveGenerated: boolean,
): RenderSdk.Schema6 => {
  const existingByKey = new Map(existingWire.map((ev) => [ev.key, ev.value]));
  const result: RenderSdk.Schema6 = [];
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
): Array<{ name: string; content: string }> => {
  if (!secretFiles) return [];
  return Object.entries(secretFiles).map(([name, content]) => ({
    name,
    content: unwrapSecret(content),
  }));
};

export const listAllServices = (params: {
  readonly ownerId?: string[];
  readonly name?: string[];
  readonly type?: RenderSdk.ServiceType[];
}) =>
  Api.paginateCursorList(
    (cursor) => RenderSdk.listServices({ ...params, cursor, limit: 100 }),
    (row) => row.service,
  );

export const deleteServiceById = (serviceId: string) =>
  Api.deleteIdempotent(RenderSdk.deleteService({ serviceId }));

export const syncCustomDomains = (
  serviceId: string,
  existing: ReadonlyArray<RenderSdk.CustomDomain>,
  desiredNames: ReadonlyArray<string> | undefined,
  verify = false,
) =>
  EffectMod.gen(function* () {
    const desired = new Set(desiredNames ?? []);
    const existingNames = new Set(existing.map((d) => d.name));
    for (const domain of existing) {
      if (!desired.has(domain.name)) {
        yield* Api.deleteIdempotent(
          RenderSdk.deleteCustomDomain({ serviceId, customDomainNameOrID: domain.id }),
        );
      }
    }
    for (const name of desired) {
      if (!existingNames.has(name)) {
        yield* RenderSdk.createCustomDomain({ serviceId, name });
      }
    }
    if (verify && desired.size > 0) {
      const current = yield* Api.paginateCursorList(
        (cursor) => RenderSdk.listCustomDomains({ serviceId, cursor, limit: 100 }),
        (row) => row.customDomain,
      );
      for (const domain of current) {
        if (desired.has(domain.name) && domain.verificationStatus !== "verified") {
          yield* RenderSdk.refreshCustomDomain({ serviceId, customDomainNameOrID: domain.id });
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
    return RenderSdk.suspendService({ serviceId }).pipe(EffectMod.asVoid);
  }
  if (desiredSuspended === false && currentSuspended === "suspended") {
    return RenderSdk.resumeService({ serviceId }).pipe(EffectMod.asVoid);
  }
  return EffectMod.void;
};

export const syncDisk = (
  serviceId: string,
  current: RenderSdk.WebServiceDetailsDisk | undefined,
  desired: DiskConfig | undefined,
) =>
  EffectMod.gen(function* () {
    if (!current && !desired) return;
    if (current && !desired) {
      yield* Api.deleteIdempotent(RenderSdk.deleteDisk({ diskId: current.id }));
      return;
    }
    if (!current && desired) {
      yield* RenderSdk.addDisk({
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
        yield* RenderSdk.updateDisk({
          diskId: current.id,
          name: desired.name,
          mountPath: desired.mountPath,
          sizeGB: targetSize,
        });
      }
    }
  });

export const syncScalingAndAutoscaling = (
  serviceId: string,
  current: RenderSdk.ServiceServiceDetails,
  desiredAutoscaling: AutoscalingConfig | undefined,
  desiredNumInstances: number | undefined,
) =>
  EffectMod.gen(function* () {
    const currentNumInstances = "numInstances" in current ? current.numInstances : undefined;
    const currentAutoscaling = "autoscaling" in current ? current.autoscaling : undefined;

    if (desiredNumInstances !== undefined && desiredNumInstances > 0) {
      if (currentNumInstances !== desiredNumInstances) {
        yield* RenderSdk.scaleService({ serviceId, numInstances: desiredNumInstances });
      }
    }
    if (!desiredAutoscaling && currentAutoscaling) {
      yield* Api.deleteIdempotent(RenderSdk.deleteAutoscalingConfig({ serviceId }));
    } else if (desiredAutoscaling && !deepEqual(currentAutoscaling, desiredAutoscaling)) {
      yield* RenderSdk.autoscaleService({
        serviceId,
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
      return yield* RenderSdk.patchServiceNotificationOverrides({
        serviceId,
        notificationsToSend: desired.notificationsToSend ?? "default",
        previewNotificationsEnabled: desired.previewNotificationsEnabled ?? "default",
      });
    }
    if (hasCurrent) {
      return yield* RenderSdk.patchServiceNotificationOverrides({
        serviceId,
        notificationsToSend: "default",
        previewNotificationsEnabled: "default",
      });
    }
    return undefined;
  });

export const syncResourceLogStream = (
  resourceId: string,
  current: RenderSdk.GetResourceLogStreamResponse | undefined,
  desired: LogStreamOverrideInput | undefined,
) =>
  EffectMod.gen(function* () {
    if (!desired && !current) return undefined;
    if (!desired && current) {
      yield* Api.deleteIdempotent(RenderSdk.deleteResourceLogStream({ resourceId }));
      return undefined;
    }
    if (desired) {
      return yield* RenderSdk.updateResourceLogStream({
        resourceId,
        setting: desired.setting,
        ...(desired.endpoint !== undefined ? { endpoint: desired.endpoint } : {}),
        ...(desired.token !== undefined ? { token: desired.token } : {}),
      });
    }
    return undefined;
  });

export const waitForServiceLive = (resourceType: string, serviceId: string) =>
  pollUntil({
    operation: "deploy",
    resourceId: serviceId,
    check: RenderSdk.listDeploys({ serviceId, limit: 5 }).pipe(
      EffectMod.map((rows) => rows.flatMap((row) => (row.deploy ? [row.deploy] : []))),
    ),
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
  readonly service: RenderSdk.Service;
  readonly envVars: RenderSdk.EnvVar[];
  readonly secretFiles: RenderSdk.SecretFile[];
  readonly customDomains: RenderSdk.CustomDomain[];
  readonly notificationOverride?: RenderSdk.GetServiceNotificationOverridesResponse;
  readonly logStreamOverride?: RenderSdk.GetResourceLogStreamResponse;
}

const supportsCustomDomains = (type: ServiceType) =>
  type === "web_service" || type === "static_site";

export const hydrateService = (
  service: RenderSdk.Service,
): Effect.Effect<
  HydratedServiceData,
  Effect.Error<ReturnType<typeof RenderSdk.getService>>,
  Effect.Services<ReturnType<typeof RenderSdk.getService>>
> =>
  EffectMod.gen(function* () {
    const envVars = yield* Api.paginateCursorList(
      (cursor) => RenderSdk.getEnvVarsForService({ serviceId: service.id, cursor, limit: 100 }),
      (row) => row.envVar,
    );
    const secretFiles = yield* Api.paginateCursorList(
      (cursor) =>
        RenderSdk.listSecretFilesForService({ serviceId: service.id, cursor, limit: 100 }),
      (row) => row.secretFile,
    );
    const customDomains = supportsCustomDomains(service.type)
      ? yield* Api.paginateCursorList(
          (cursor) => RenderSdk.listCustomDomains({ serviceId: service.id, cursor, limit: 100 }),
          (row) => row.customDomain,
        )
      : [];
    const notificationOverride = yield* Api.ignoreNotFound(
      RenderSdk.getServiceNotificationOverrides({ serviceId: service.id }),
    );
    const logStreamOverride = yield* Api.ignoreNotFound(
      RenderSdk.getResourceLogStream({ resourceId: service.id }),
    );
    return {
      service,
      envVars,
      secretFiles,
      customDomains,
      notificationOverride,
      logStreamOverride,
    };
  });

const extractNativeOrDocker = (details: RenderSdk.ServiceServiceDetails) => {
  if (!("envSpecificDetails" in details) || !details.envSpecificDetails) {
    return {};
  }
  const envDetails = details.envSpecificDetails;
  if ("buildCommand" in envDetails) {
    return {
      buildCommand: envDetails.buildCommand,
      startCommand: envDetails.startCommand.length > 0 ? envDetails.startCommand : undefined,
      preDeployCommand:
        envDetails.preDeployCommand && envDetails.preDeployCommand.length > 0
          ? envDetails.preDeployCommand
          : undefined,
    };
  }
  return {
    startCommand:
      envDetails.dockerCommand && envDetails.dockerCommand.length > 0
        ? envDetails.dockerCommand
        : undefined,
    preDeployCommand:
      envDetails.preDeployCommand && envDetails.preDeployCommand.length > 0
        ? envDetails.preDeployCommand
        : undefined,
    registryCredentialId: envDetails.registryCredential?.id,
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
  const runtime =
    "runtime" in d ? d.runtime : "env" in d && typeof d.env === "string" ? d.env : "unknown";
  const disk = "disk" in d ? d.disk : undefined;

  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    ownerId: s.ownerId,
    environmentId: s.environmentId,
    runtime,
    plan: "plan" in d ? d.plan : undefined,
    region: "region" in d ? d.region : undefined,
    buildPlan: "buildPlan" in d ? d.buildPlan : undefined,
    repo: s.repo,
    branch: s.branch,
    imagePath: s.imagePath,
    rootDirectory: s.rootDir,
    buildCommand:
      "buildCommand" in d && typeof d.buildCommand === "string"
        ? d.buildCommand
        : extracted.buildCommand,
    startCommand: extracted.startCommand,
    preDeployCommand: extracted.preDeployCommand,
    autoDeploy: s.autoDeploy === "yes",
    autoDeployTrigger: s.autoDeployTrigger,
    buildFilter: s.buildFilter,
    registryCredentialId: s.registryCredential?.id ?? extracted.registryCredentialId,
    dashboardUrl: s.dashboardUrl,
    suspended: s.suspended,
    maxShutdownDelaySeconds: "maxShutdownDelaySeconds" in d ? d.maxShutdownDelaySeconds : undefined,
    previews: "previews" in d ? d.previews : undefined,
    envVars: envVarsRecord,
    secretFiles: data.secretFiles.map((f) => ({ name: f.name, content: toRedacted(f.content) })),
    disk: disk
      ? {
          id: disk.id,
          name: disk.name,
          mountPath: disk.mountPath,
          sizeGB: disk.sizeGB,
        }
      : undefined,
    numInstances: "numInstances" in d ? d.numInstances : undefined,
    autoscaling: "autoscaling" in d ? d.autoscaling : undefined,
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
    sshAddress: "sshAddress" in d ? d.sshAddress : undefined,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
};

export const mapCustomDomains = (
  domains: ReadonlyArray<RenderSdk.CustomDomain>,
): CustomDomainInfo[] =>
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
      const svc = yield* Api.ignoreNotFound(RenderSdk.getService({ serviceId: options.output.id }));
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
    const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
    const list = yield* listAllServices({
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
    const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
    const list = yield* listAllServices({
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
    const ownerId = yield* Api.resolveOwnerId(news.ownerId);

    const existingList = yield* listAllServices({
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
    const envSpecificDetails = buildEnvSpecificDetailsCreate(news.runtimeSource, startCmd);
    const sharedDetails: RenderSdk.PrivateServiceDetailsPOST = {
      runtime,
      plan,
      ...(news.region !== undefined ? { region: news.region } : {}),
      numInstances: isResolved(news.numInstances) ? (news.numInstances ?? 1) : 1,
      envSpecificDetails,
    };

    const createdRes = yield* RenderSdk.createService({
      ...sourceFields,
      name: desiredName,
      ownerId,
      type: options.serviceType,
      autoDeploy: "no",
      serviceDetails: sharedDetails,
    });

    const service = createdRes.service
      ? createdRes.service
      : yield* listAllServices({
          ownerId: [ownerId],
          name: [desiredName],
          type: [options.serviceType],
        }).pipe(EffectMod.map((rows) => rows.find((s) => s.name === desiredName)));

    if (!service) {
      return yield* new RenderSdk.NotFound({
        message: `Render precreated service "${desiredName}" was not returned after creation.`,
      });
    }

    const fresh = yield* RenderSdk.getService({ serviceId: service.id });
    return options.toAttributes(yield* hydrateService(fresh));
  });

export const findServiceByLookup = (
  serviceType: ServiceType,
  props: { id?: string; name?: string; ownerId?: string },
) =>
  EffectMod.gen(function* () {
    if (props.id) {
      const svc = yield* Api.ignoreNotFound(RenderSdk.getService({ serviceId: props.id }));
      if (!svc || svc.type !== serviceType) return undefined;
      return yield* hydrateService(svc);
    }
    if (!props.name) return undefined;
    const ownerId = yield* Api.resolveOwnerId(props.ownerId);
    const list = yield* listAllServices({
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
    const ownerId = yield* Api.resolveOwnerId();
    const list = yield* listAllServices({ ownerId: [ownerId], type: [serviceType] });
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
): RenderSdk.MaintenanceMode | undefined => {
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

export const pickPreviews = (news: LongRunningServiceProps): RenderSdk.Previews | undefined => {
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
  readonly extraCreateDetails: (
    news: Props,
    olds: Props | undefined,
  ) => Partial<RenderSdk.WebServiceDetailsPOST>;
  readonly extraUpdateDetails: (
    news: Props,
    olds: Props | undefined,
  ) => Partial<RenderSdk.WebServiceDetailsPATCH>;
  readonly extraDesiredCustomDomains?: (news: Props) => ReadonlyArray<string> | undefined;
  readonly extraVerifyCustomDomains?: (news: Props) => boolean | undefined;
  readonly toAttributes: (data: HydratedServiceData) => Attrs;
}) =>
  EffectMod.gen(function* () {
    const { news, olds, output } = options;
    yield* validateRuntimeSource(news.runtimeSource, news.startCommand);

    const existing = output?.id
      ? yield* Api.ignoreNotFound(RenderSdk.getService({ serviceId: output.id }))
      : undefined;

    const mergedEnv = mergeBoundEnvVars(news.envVars, options.bindings);
    const runtime = runtimeOfSource(news.runtimeSource);

    if (!existing) {
      const ownerId = yield* Api.resolveOwnerId(news.ownerId);
      const envVarsWire = envVarsToWire(mergedEnv, [], false);
      const secretFilesWire = secretFilesToWire(news.secretFiles);
      const previews = pickPreviews(news);
      const pullRequestPreviewsEnabled =
        news.pullRequestPreviewsEnabled !== undefined
          ? news.pullRequestPreviewsEnabled
            ? ("yes" as const)
            : ("no" as const)
          : undefined;
      const serviceDetails: RenderSdk.WebServiceDetailsPOST = {
        runtime,
        plan:
          ("plan" in news && typeof news.plan === "string" ? news.plan : undefined) ??
          options.defaultPlan,
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
        ...(previews !== undefined ? { previews } : {}),
        ...(pullRequestPreviewsEnabled !== undefined ? { pullRequestPreviewsEnabled } : {}),
        ...options.extraCreateDetails(news, olds),
      };

      const createdRes = yield* RenderSdk.createService({
        ...buildSourceFieldsCreate(news.runtimeSource, ownerId),
        name: options.desiredName,
        ownerId,
        type: options.serviceType,
        ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
        ...(envVarsWire.length > 0 ? { envVars: envVarsWire } : {}),
        ...(secretFilesWire.length > 0 ? { secretFiles: secretFilesWire } : {}),
        serviceDetails,
      });

      const service = createdRes.service
        ? createdRes.service
        : yield* listAllServices({
            ownerId: [ownerId],
            name: [options.desiredName],
            type: [options.serviceType],
          }).pipe(EffectMod.map((rows) => rows[0]));

      if (!service) {
        return yield* new RenderSdk.NotFound({
          message: `Render service "${options.desiredName}" was not returned after creation.`,
        });
      }

      if (news.environmentId !== undefined) {
        yield* Api.syncResourceEnvironment(service.id, service.environmentId, news.environmentId);
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

      const fresh = yield* RenderSdk.getService({ serviceId: service.id });
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

    const previews = pickPreviews(news);
    const pullRequestPreviewsEnabled =
      news.pullRequestPreviewsEnabled !== undefined
        ? news.pullRequestPreviewsEnabled
          ? ("yes" as const)
          : ("no" as const)
        : undefined;
    const updateDetails: RenderSdk.WebServiceDetailsPATCH = {
      runtime,
      plan:
        ("plan" in news && typeof news.plan === "string" ? news.plan : undefined) ??
        options.defaultPlan,
      envSpecificDetails: buildEnvSpecificDetailsUpdate(news.runtimeSource, news.startCommand),
      preDeployCommand: news.preDeployCommand ?? "",
      ...(news.maxShutdownDelaySeconds !== undefined
        ? { maxShutdownDelaySeconds: news.maxShutdownDelaySeconds }
        : {}),
      ...(previews !== undefined ? { previews } : {}),
      ...(pullRequestPreviewsEnabled !== undefined ? { pullRequestPreviewsEnabled } : {}),
      ...options.extraUpdateDetails(news, olds),
    };

    yield* RenderSdk.updateService({
      ...buildSourceFieldsCreate(news.runtimeSource, existing.ownerId),
      serviceId: existing.id,
      name: options.desiredName,
      ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
      serviceDetails: updateDetails,
    });

    const desiredEnvWire = envVarsToWire(mergedEnv, hydratedBefore.envVars, true);
    yield* RenderSdk.updateEnvVarsForService({ serviceId: existing.id, body: desiredEnvWire });

    const desiredFilesWire = secretFilesToWire(news.secretFiles);
    yield* RenderSdk.updateSecretFilesForService({
      serviceId: existing.id,
      body: desiredFilesWire,
    });

    const existingDisk =
      "disk" in existing.serviceDetails ? existing.serviceDetails.disk : undefined;
    yield* syncDisk(existing.id, existingDisk, news.disk);
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
    yield* Api.syncResourceEnvironment(existing.id, existing.environmentId, news.environmentId);

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
      yield* RenderSdk.createDeploy({ serviceId: existing.id });
    }

    if (news.waitForDeployCompletion) {
      yield* waitForServiceLive(options.resourceType, existing.id);
    }

    const refreshed = yield* RenderSdk.getService({ serviceId: existing.id });
    const hydratedAfter = yield* hydrateService(refreshed);
    return options.toAttributes(hydratedAfter);
  });
