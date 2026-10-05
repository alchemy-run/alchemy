import * as app from "@distilled.cloud/azure/app";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  descriptionWithMarker,
  normalizeScope,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import { roleDefinitionIdOf } from "../Authorization/RoleAssignment.ts";
import type { AzureBindingContract } from "../Binding.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createContainerAppsName,
  fingerprint,
  getContainerApp,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  secretsMatch,
  toIdentity,
  toSecrets,
  type ContainerAppsIdentity,
  type ContainerAppsSecret,
} from "./common.ts";

export type { ContainerAppsIdentity, ContainerAppsSecret } from "./common.ts";

/**
 * App-level configuration: ingress, revision mode, registries, Dapr,
 * runtime settings. Secrets are set with the separate `secrets` prop.
 */
export type ContainerAppConfiguration = Omit<app.ConfigurationInput, "secrets">;

/** Versioned template: containers, scale rules, volumes. */
export type ContainerAppTemplate = app.TemplateInput;

export interface ContainerAppProps {
  /** Resource group the app is created in. Changing it replaces the app. */
  resourceGroup: string;
  /**
   * App name: 2-32 lowercase letters, digits, and hyphens, starting with a
   * letter and without `--`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the app.
   */
  name?: string;
  /**
   * Azure location; must match the environment's location. Changing it
   * replaces the app.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Container Apps environment (`environment.environmentId`).
   * Changing it replaces the app.
   */
  environmentId: string;
  /**
   * Workload profile of the environment to run on.
   * @default the environment's Consumption profile
   */
  workloadProfileName?: string;
  /** App-level configuration (ingress, revision mode, registries, Dapr). */
  configuration?: ContainerAppConfiguration;
  /**
   * Revision template: containers, scale, and volumes. Changing it
   * creates a new revision.
   */
  template: ContainerAppTemplate;
  /**
   * Secrets referenced by env vars (`secretRef`), registries
   * (`passwordSecretRef`), and scale rules.
   */
  secrets?: ContainerAppsSecret[];
  /** Managed identity of the app. */
  identity?: ContainerAppsIdentity;
  /**
   * App kind: `workflowapp` (Logic Apps Standard host, see
   * `ContainerApps.LogicApp`) or `functionapp`. Changing it replaces the app.
   */
  kind?: "workflowapp" | "functionapp";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ContainerApp extends Resource<
  "Azure.ContainerApps.ContainerApp",
  ContainerAppProps,
  {
    /** Name of the container app. */
    containerAppName: string;
    /** ARM resource ID of the app; use it as a role-assignment scope. */
    containerAppId: string;
    /** Resource group that holds the app. */
    resourceGroup: string;
    /** Location of the app. */
    location: string;
    /** ARM ID of the environment the app runs in. */
    environmentId: string;
    /** Ingress FQDN, when ingress is enabled. */
    fqdn: string | undefined;
    /** `https://{fqdn}`, when ingress is enabled. */
    url: string | undefined;
    /** Name of the latest revision. */
    latestRevisionName: string | undefined;
    /** Name of the latest revision that is ready. */
    latestReadyRevisionName: string | undefined;
    /** Outbound IP addresses of the app. */
    outboundIpAddresses: string[];
    /** ID to put in the `asuid` TXT record when binding a custom domain. */
    customDomainVerificationId: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  AzureBindingContract,
  Providers
> {}

/**
 * An Azure Container App (`Microsoft.App/containerApps`) — a serverless
 * container service with revisions, HTTP ingress, and scale-to-zero, hosted
 * in a `ManagedEnvironment`.
 *
 * Deploys block until the latest revision is ready.
 *
 * @see https://learn.microsoft.com/azure/container-apps/overview
 *
 * ### Creating a Container App
 * **Example:** Public HTTP app that scales to zero
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   configuration: { ingress: { external: true, targetPort: 80 } },
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         resources: { cpu: 0.25, memory: "0.5Gi" },
 *       },
 *     ],
 *     scale: { minReplicas: 0, maxReplicas: 1 },
 *   },
 * });
 * ```
 *
 * ### Secrets and Environment Variables
 * **Example:** Reference a secret from an env var
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   secrets: [{ name: "db-password", value: Redacted.make(password) }],
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         env: [
 *           { name: "MODE", value: "production" },
 *           { name: "DB_PASSWORD", secretRef: "db-password" },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Identity
 * **Example:** System-assigned identity
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   identity: { type: "SystemAssigned" },
 *   template: { containers: [{ name: "api", image }] },
 * });
 * // api.principalId can now be granted roles
 * ```
 *
 * @resource
 */
export const ContainerApp = Resource<ContainerApp>(
  "Azure.ContainerApps.ContainerApp",
);

const createAppName = (id: string) => createContainerAppsName(id, 32);

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetContainerAppResponse,
): ContainerApp["Attributes"] => {
  const props = observed.properties;
  const fqdn = props?.configuration?.ingress?.fqdn;
  return {
    containerAppName: name,
    containerAppId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    environmentId: props?.managedEnvironmentId ?? props?.environmentId ?? "",
    fqdn,
    url: fqdn ? `https://${fqdn}` : undefined,
    latestRevisionName: props?.latestRevisionName,
    latestReadyRevisionName: props?.latestReadyRevisionName,
    outboundIpAddresses: [...(props?.outboundIpAddresses ?? [])],
    customDomainVerificationId: props?.customDomainVerificationId,
    principalId: observed.identity?.principalId,
    tags: userTags(observed.tags),
  };
};

/** The desired `properties` body (secret values revealed). */
const toProperties = (
  props: ContainerAppProps,
  bindingEnv: Record<string, string> = {},
): app.ContainerAppPropertiesInput => ({
  managedEnvironmentId: props.environmentId,
  workloadProfileName: props.workloadProfileName,
  configuration: { ...props.configuration, secrets: toSecrets(props.secrets) },
  template: withBindingEnv(props.template, bindingEnv),
});

/** Add binding env vars to every container; explicit container env wins. */
const withBindingEnv = (
  template: ContainerAppTemplate,
  bindingEnv: Record<string, string>,
): ContainerAppTemplate => {
  const names = Object.keys(bindingEnv).sort();
  if (names.length === 0) return template;
  return {
    ...template,
    containers: template.containers?.map((container) => {
      const own = container.env ?? [];
      const taken = new Set(own.map((e) => e.name));
      return {
        ...container,
        env: [
          ...own,
          ...names
            .filter((name) => !taken.has(name))
            .map((name) => ({ name, value: bindingEnv[name] })),
        ],
      };
    }),
  };
};

/** Active binding data (bindings being removed are excluded). */
const activeBindings = (
  bindings: ReadonlyArray<ResourceBinding<AzureBindingContract>>,
) =>
  bindings.filter(
    (b: ResourceBinding<AzureBindingContract> & { action?: string }) =>
      b.action !== "delete",
  );

const bindingEnvOf = (
  bindings: ReadonlyArray<ResourceBinding<AzureBindingContract>>,
) =>
  activeBindings(bindings).reduce<Record<string, string>>(
    (acc, b) => ({ ...acc, ...b.data?.env }),
    {},
  );

const bindingGrantsOf = (
  bindings: ReadonlyArray<ResourceBinding<AzureBindingContract>>,
) => activeBindings(bindings).flatMap((b) => b.data?.roleAssignments ?? []);

/** Identity with SystemAssigned enabled, as binding role grants need it. */
const withSystemIdentity = (
  identity: ContainerAppsIdentity | undefined,
): ContainerAppsIdentity => {
  switch (identity?.type) {
    case undefined:
    case "None":
      return { type: "SystemAssigned" };
    case "UserAssigned":
      return { ...identity, type: "SystemAssigned,UserAssigned" };
    default:
      return identity ?? { type: "SystemAssigned" };
  }
};

/** Deterministic assignment name: one per (app, scope, role). */
const bindingAssignmentName = (appId: string, scope: string, role: string) =>
  Effect.sync(() => {
    const hex = createHash("sha256")
      .update(
        `${appId.toLowerCase()}|${normalizeScope(scope)}|${role.toLowerCase()}`,
      )
      .digest("hex");
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  });

const roleGuid = (roleDefinitionId: string) =>
  (roleDefinitionId.split("/").pop() ?? roleDefinitionId).toLowerCase();

/** Binding-created role assignments currently held by `principalId`. */
const listBindingAssignments = (
  subscriptionId: string,
  principalId: string,
  marker: string,
) =>
  authorization
    .ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    })
    .pipe(
      Effect.flatMap((page) =>
        requireSinglePage("ListRoleAssignmentForSubscription", page),
      ),
      Effect.map((page) =>
        page.value.filter((a) =>
          (a.properties?.description ?? "").endsWith(marker),
        ),
      ),
    );

/** Binding marker; distinct from `RoleAssignment`'s so `list` ignores it. */
const bindingMarker = (id: string) => ownershipMarker(`${id}#binding`);

/**
 * Converge the app identity's role assignments to exactly the binding
 * grants: create missing ones, delete binding-created ones no longer wanted.
 */
export const syncBindingAssignments = Effect.fn(function* (options: {
  id: string;
  subscriptionId: string;
  appId: string;
  principalId: string;
  grants: ReadonlyArray<{ roleDefinitionId: string; scope: string }>;
}) {
  const marker = yield* bindingMarker(options.id);
  const observed = yield* listBindingAssignments(
    options.subscriptionId,
    options.principalId,
    marker,
  );
  const desired = new Map<
    string,
    { roleDefinitionId: string; scope: string }
  >();
  for (const grant of options.grants) {
    const name = yield* bindingAssignmentName(
      options.appId,
      grant.scope,
      roleGuid(grant.roleDefinitionId),
    );
    desired.set(name, grant);
  }
  const observedNames = new Set(observed.map((a) => a.name));
  for (const [name, grant] of desired) {
    if (observedNames.has(name)) continue;
    yield* authorization
      .CreateRoleAssignment({
        scope: grant.scope,
        roleAssignmentName: name,
        properties: {
          roleDefinitionId: roleDefinitionIdOf(
            options.subscriptionId,
            grant.roleDefinitionId,
          ),
          principalId: options.principalId,
          principalType: "ServicePrincipal",
          description: descriptionWithMarker("Alchemy binding", marker),
        },
      })
      .pipe(
        // A fresh system identity takes a moment to replicate through Entra ID.
        Effect.retry({
          while: (e) => e._tag === "PrincipalNotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
        Effect.catchTag("RoleAssignmentExists", () => Effect.void),
      );
  }
  for (const stale of observed) {
    if (stale.name === undefined || desired.has(stale.name)) continue;
    const scope = stale.properties?.scope;
    if (scope === undefined) continue;
    yield* ignoreNotFound(
      authorization.DeleteRoleAssignment({
        scope,
        roleAssignmentName: stale.name,
      }),
    );
  }
});

/**
 * Ready once provisioning succeeded and the latest revision is ready, so
 * callers can route traffic as soon as the deploy returns. Express
 * environments never report a ready revision; their single revision is
 * ready when provisioning succeeds.
 */
const appState = (observed: app.GetContainerAppResponse) => {
  const props = observed.properties;
  const state = props?.provisioningState ?? "InProgress";
  if (state !== "Succeeded") return state;
  return props?.latestReadyRevisionName !== undefined &&
    props.latestReadyRevisionName !== props.latestRevisionName
    ? "RevisionProvisioning"
    : "Succeeded";
};

export const ContainerAppProvider = () =>
  Provider.succeed(ContainerApp, {
    stables: [
      "containerAppName",
      "containerAppId",
      "resourceGroup",
      "location",
      "customDomainVerificationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListContainerAppBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListContainerAppBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (olds !== undefined && lower(news.kind) !== lower(olds.kind)) ||
        (news.name !== undefined && news.name !== output.containerAppName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.environmentId) !== lower(output.environmentId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.containerAppName ?? olds?.name ?? (yield* createAppName(id));
      const observed = yield* getContainerApp(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.containerAppName ?? (yield* createAppName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const bindingEnv = bindingEnvOf(bindings);
      const grants = bindingGrantsOf(bindings);
      const identity =
        grants.length > 0 ? withSystemIdentity(news.identity) : news.identity;
      const properties = toProperties(news, bindingEnv);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        containerAppName: name,
      };
      const get = getContainerApp(subscriptionId, resourceGroup, name);
      const put = app.ContainerAppsCreateOrUpdate({
        ...where,
        location,
        tags,
        identity: toIdentity(identity),
        kind: news.kind,
        properties,
      });
      const ready = waitForProvisioned(`container app ${name}`, get, appState, {
        interval: "5 seconds",
        times: 60,
      });

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT carries the full desired state.
      if (observed === undefined) {
        yield* put;
        observed = yield* ready;
      } else {
        // Wait out an in-flight operation before comparing.
        observed = yield* ready;
        // Sync. ARM echoes defaults back, so compare the desired subset;
        // secret values are only observable through `listSecrets`, and
        // removed properties only against the previous props.
        const secrets = toSecrets(news.secrets);
        const configuration = news.configuration;
        const observedSecrets =
          secrets.length > 0 ||
          (observed.properties?.configuration?.secrets ?? []).length > 0
            ? (yield* orUndefinedIfNotFound(app.ListContainerAppSecrets(where)))
                ?.value
            : [];
        const inSync =
          matchesDesired(
            { ...properties, configuration },
            observed.properties,
          ) &&
          secretsMatch(secrets, observedSecrets) &&
          identityMatches(identity, observed.identity) &&
          !tagsDiffer(observed.tags, tags) &&
          (olds === undefined ||
            fingerprint(properties) ===
              fingerprint(toProperties(olds, bindingEnv)));
        if (!inSync) {
          yield* put;
          observed = yield* ready;
        }
      }

      // Sync binding role grants against the identity's observed
      // assignments; also prunes grants of bindings that were removed.
      const principalId = observed.identity?.principalId;
      if (principalId !== undefined && observed.id !== undefined) {
        yield* syncBindingAssignments({
          id,
          subscriptionId,
          appId: observed.id,
          principalId,
          grants,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ id, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Role assignments outlive their principal; remove binding grants first.
      if (output.principalId !== undefined) {
        const marker = yield* bindingMarker(id);
        const held = yield* listBindingAssignments(
          subscriptionId,
          output.principalId,
          marker,
        );
        for (const assignment of held) {
          if (assignment.name === undefined) continue;
          const scope = assignment.properties?.scope;
          if (scope === undefined) continue;
          yield* ignoreNotFound(
            authorization.DeleteRoleAssignment({
              scope,
              roleAssignmentName: assignment.name,
            }),
          );
        }
      }
      yield* ignoreNotFound(
        app.DeleteContainerApp({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerAppName: output.containerAppName,
        }),
      );
      yield* waitUntilGone(
        `container app ${output.containerAppName}`,
        getContainerApp(
          subscriptionId,
          output.resourceGroup,
          output.containerAppName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerApps.ManagedEnvironment",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
