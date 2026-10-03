import * as resources from "@distilled.cloud/azure/resources";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameId, sameJson } from "./Shared.ts";

export interface DeploymentScriptProps {
  /** Resource group to run the script in. Changing it replaces the script. */
  resourceGroup: string;
  /**
   * Name of the deployment script (1-90 characters). If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the script.
   */
  name?: string;
  /**
   * Azure region for the script and its temporary container instance.
   * Changing it replaces the script.
   * @default the provider's configured location
   */
  location?: string;
  /** Script runtime. Changing it replaces the script. */
  kind: "AzureCLI" | "AzurePowerShell";
  /**
   * Azure CLI version of the container image (`kind: "AzureCLI"`).
   * Changing it replaces the script.
   * @default "2.61.0"
   */
  azCliVersion?: string;
  /**
   * Azure PowerShell version of the container image
   * (`kind: "AzurePowerShell"`). Changing it replaces the script.
   * @default "11.0"
   */
  azPowerShellVersion?: string;
  /**
   * Inline script body. Set exactly one of `scriptContent` or
   * `primaryScriptUri`. Changing it replaces the script (a new run).
   */
  scriptContent?: string;
  /** URI of the script entry point. Changing it replaces the script. */
  primaryScriptUri?: string;
  /** URIs of supporting files for `primaryScriptUri`. Changing them replaces the script. */
  supportingScriptUris?: string[];
  /** Command-line arguments passed to the script. Changing them replaces the script. */
  arguments?: string;
  /** Environment variables for the script. Changing them replaces the script. */
  environmentVariables?: Record<string, string>;
  /**
   * Secret environment variables for the script. ARM never returns their
   * values, so only added or removed names are detected; bump
   * `forceUpdateTag` to re-run with a changed value.
   */
  secureEnvironmentVariables?: Record<string, Redacted.Redacted<string>>;
  /**
   * ARM ID of a user-assigned managed identity the script runs as (needed
   * to call Azure from the script). Changing it replaces the script.
   */
  identity?: string;
  /**
   * Change this value to re-run the script in place without changing its
   * content.
   */
  forceUpdateTag?: string;
  /**
   * How long ARM keeps the script resource after it finishes (ISO 8601,
   * `PT1H` to `PT26H`). Changing it replaces the script.
   * @default "PT1H"
   */
  retentionInterval?: string;
  /**
   * Maximum execution time (ISO 8601). Changing it replaces the script.
   * @default "PT30M"
   */
  timeout?: string;
  /**
   * When ARM removes the temporary storage account and container instance:
   * `Always`, `OnSuccess`, or `OnExpiration`. Changing it replaces the
   * script.
   * @default "Always"
   */
  cleanupPreference?: "Always" | "OnSuccess" | "OnExpiration";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DeploymentScript extends Resource<
  "Azure.Resources.DeploymentScript",
  DeploymentScriptProps,
  {
    /** Name of the deployment script. */
    deploymentScriptName: string;
    /** ARM ID of the deployment script. */
    deploymentScriptId: string;
    /** Resource group of the script. */
    resourceGroup: string;
    /** Azure region of the script. */
    location: string;
    /** Script runtime (`AzureCLI` or `AzurePowerShell`). */
    kind: string;
    /**
     * JSON the script wrote to `$AZ_SCRIPTS_OUTPUT_PATH`, e.g.
     * `{ greeting: "hello" }`.
     */
    outputs: Record<string, unknown>;
    /** Provisioning state of the last run (`Succeeded`). */
    provisioningState: string | undefined;
    /** Force-update tag of the last run. */
    forceUpdateTag: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure deployment script — runs an Azure CLI or Azure PowerShell script
 * once in a temporary container instance and exposes the JSON it writes to
 * `$AZ_SCRIPTS_OUTPUT_PATH` as `outputs`.
 *
 * Changing the script, its runtime, or its inputs replaces the resource
 * (a new run); change `forceUpdateTag` to re-run it in place. ARM creates a
 * temporary storage account and container instance in the resource group
 * and removes them according to `cleanupPreference`.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-script-template
 *
 * ### Running a Script
 * **Example:** Azure CLI script with an output
 * ```typescript
 * const script = yield* Azure.Resources.DeploymentScript("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "AzureCLI",
 *   environmentVariables: { NAME: "world" },
 *   scriptContent:
 *     'echo "{\\"greeting\\": \\"hello $NAME\\"}" > $AZ_SCRIPTS_OUTPUT_PATH',
 * });
 * // script.outputs.greeting === "hello world"
 * ```
 *
 * ### Calling Azure from the Script
 * **Example:** Run as a user-assigned identity
 * ```typescript
 * yield* Azure.Resources.DeploymentScript("list-groups", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "AzureCLI",
 *   identity: identity.identityId,
 *   scriptContent: "az group list > $AZ_SCRIPTS_OUTPUT_PATH",
 *   forceUpdateTag: "v2",
 * });
 * ```
 *
 * @resource
 */
export const DeploymentScript = Resource<DeploymentScript>(
  "Azure.Resources.DeploymentScript",
);

export class DeploymentScriptFailed extends Data.TaggedError(
  "Azure.Resources.DeploymentScriptFailed",
)<{
  readonly deploymentScript: string;
  readonly code: string | undefined;
  readonly message: string;
}> {}

const scriptNameOf = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 63 });

const getScript = (
  subscriptionId: string,
  resourceGroupName: string,
  scriptName: string,
) =>
  orUndefinedIfNotFound(
    resources.GetDeploymentScript({
      subscriptionId,
      resourceGroupName,
      scriptName,
    }),
  );

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
  observed: resources.GetDeploymentScriptResponse,
): DeploymentScript["Attributes"] => ({
  deploymentScriptName: name,
  deploymentScriptId:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deploymentScripts/${name}`,
  resourceGroup,
  location: observed.location,
  kind: observed.kind,
  outputs: asRecord(observed.properties?.outputs),
  provisioningState: observed.properties?.provisioningState,
  forceUpdateTag: observed.properties?.forceUpdateTag,
  tags: userTags(observed.tags),
});

const IN_FLIGHT = new Set([
  "Creating",
  "ProvisioningResources",
  "Running",
  "Updating",
]);

/** Poll until the run settles; a failed run surfaces the script's error. */
const waitForRun = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `deployment script ${name}`,
    getScript(subscriptionId, resourceGroup, name),
    (script) => script.properties?.provisioningState,
    { interval: "10 seconds", times: 90 },
  ).pipe(
    Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
      getScript(subscriptionId, resourceGroup, name).pipe(
        Effect.flatMap((script) => {
          const error = script?.properties?.status?.error?.error;
          return Effect.fail(
            new DeploymentScriptFailed({
              deploymentScript: name,
              code: error?.code,
              message: `deployment script ${name} ended in state '${failure.state}': ${error?.message ?? "no error details"}`,
            }),
          );
        }),
      ),
    ),
  );

const toEnvironment = (
  plain: Record<string, string> | undefined,
  secure: Record<string, Redacted.Redacted<string>> | undefined,
): resources.DeploymentScriptEnvironmentVariable[] | undefined => {
  const variables = [
    ...Object.entries(plain ?? {}).map(([name, value]) => ({ name, value })),
    ...Object.entries(secure ?? {}).map(([name, value]) => ({
      name,
      secureValue: Redacted.value(value),
    })),
  ];
  return variables.length === 0 ? undefined : variables;
};

/** Observed plain environment variables (secure values are never returned). */
const observedEnvironment = (
  variables: resources.DeploymentScriptEnvironmentVariable[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (variables ?? []).flatMap((variable) =>
      variable.value === undefined ? [] : [[variable.name, variable.value]],
    ),
  );

/** The parts of the script definition a run is made of. */
const definitionOf = (props: DeploymentScriptProps) => ({
  azCliVersion: props.azCliVersion,
  azPowerShellVersion: props.azPowerShellVersion,
  scriptContent: props.scriptContent,
  primaryScriptUri: props.primaryScriptUri,
  supportingScriptUris: props.supportingScriptUris,
  arguments: props.arguments,
  environmentVariables: props.environmentVariables,
  secureEnvironmentVariables: Object.keys(
    props.secureEnvironmentVariables ?? {},
  ).sort(),
  identity: props.identity?.toLowerCase(),
  retentionInterval: props.retentionInterval,
  timeout: props.timeout,
  cleanupPreference: props.cleanupPreference,
});

export const DeploymentScriptProvider = () =>
  Provider.succeed(DeploymentScript, {
    stables: [
      "deploymentScriptName",
      "deploymentScriptId",
      "resourceGroup",
      "location",
      "kind",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListDeploymentScriptBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDeploymentScriptBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((script) => {
        const group = resourceGroupOf(script.id);
        return script.name !== undefined &&
          group !== undefined &&
          hasAnyAlchemyTag(script.tags)
          ? [toAttrs(subscriptionId, group, script.name, script)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) {
        return !("resourceGroup" in news) || !isResolved(news.resourceGroup)
          ? ({ action: "replace" } as const)
          : undefined;
      }
      const { location } = yield* AzureEnvironment.current;
      const region = (value: string) => value.toLowerCase().replace(/\s/g, "");
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.deploymentScriptName.toLowerCase()) ||
        region(news.location ?? location) !== region(output.location) ||
        news.kind !== output.kind
      ) {
        return { action: "replace" } as const;
      }
      // The script definition is immutable: a changed input is a new run.
      if (
        olds !== undefined &&
        !sameJson(definitionOf(news), definitionOf(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const group = output?.resourceGroup ?? olds?.resourceGroup;
      if (group === undefined) return undefined;
      const name =
        output?.deploymentScriptName ?? (yield* scriptNameOf(id, olds?.name));
      const observed = yield* getScript(subscriptionId, group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, group, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Resources");
      // ARM provisions the run's storage account and container instance in
      // this subscription.
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerInstance");
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const group = news.resourceGroup;
      const name =
        output?.deploymentScriptName ?? (yield* scriptNameOf(id, news.name));
      const location = news.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe. A run still in flight settles first.
      let observed = yield* getScript(subscriptionId, group, name);
      if (IN_FLIGHT.has(observed?.properties?.provisioningState ?? "")) {
        observed = yield* waitForRun(subscriptionId, group, name).pipe(
          Effect.catchTag("Azure.Resources.DeploymentScriptFailed", () =>
            getScript(subscriptionId, group, name),
          ),
        );
      }

      // Ensure. Every PUT is a run: only write when the script is missing,
      // its last run did not succeed, its observed definition drifted
      // (e.g. on adoption), or `forceUpdateTag` changed.
      const current = observed?.properties;
      const observedIdentity = Object.keys(
        observed?.identity?.userAssignedIdentities ?? {},
      )[0];
      const definitionDrifted =
        current !== undefined &&
        ((news.scriptContent !== undefined &&
          current.scriptContent !== news.scriptContent) ||
          (news.primaryScriptUri !== undefined &&
            current.primaryScriptUri !== news.primaryScriptUri) ||
          (current.arguments ?? "") !== (news.arguments ?? "") ||
          !sameJson(
            observedEnvironment(current.environmentVariables),
            news.environmentVariables ?? {},
          ) ||
          (news.identity !== undefined &&
            !sameId(observedIdentity, news.identity)));
      if (
        observed === undefined ||
        current?.provisioningState !== "Succeeded" ||
        definitionDrifted ||
        (news.forceUpdateTag !== undefined &&
          current.forceUpdateTag !== news.forceUpdateTag)
      ) {
        yield* resources.CreateDeploymentScript({
          subscriptionId,
          resourceGroupName: group,
          scriptName: name,
          location,
          kind: news.kind,
          tags,
          identity:
            news.identity === undefined
              ? undefined
              : {
                  type: "UserAssigned",
                  userAssignedIdentities: { [news.identity]: {} },
                },
          properties: {
            azCliVersion:
              news.kind === "AzureCLI"
                ? (news.azCliVersion ?? "2.61.0")
                : undefined,
            azPowerShellVersion:
              news.kind === "AzurePowerShell"
                ? (news.azPowerShellVersion ?? "11.0")
                : undefined,
            scriptContent: news.scriptContent,
            primaryScriptUri: news.primaryScriptUri,
            supportingScriptUris: news.supportingScriptUris,
            arguments: news.arguments,
            environmentVariables: toEnvironment(
              news.environmentVariables,
              news.secureEnvironmentVariables,
            ),
            forceUpdateTag: news.forceUpdateTag,
            retentionInterval: news.retentionInterval ?? "PT1H",
            timeout: news.timeout ?? "PT30M",
            cleanupPreference: news.cleanupPreference ?? "Always",
          },
        });
        observed = yield* waitForRun(subscriptionId, group, name);
      }

      // Sync tags (a PATCH does not re-run the script).
      if (tagsDiffer(observed.tags, tags)) {
        yield* resources.UpdateDeploymentScript({
          subscriptionId,
          resourceGroupName: group,
          scriptName: name,
          tags,
        });
      }

      const fresh = yield* getScript(subscriptionId, group, name);
      return toAttrs(subscriptionId, group, name, fresh ?? observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeleteDeploymentScript({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          scriptName: output.deploymentScriptName,
        }),
      );
      yield* waitUntilGone(
        `deployment script ${output.deploymentScriptName}`,
        getScript(
          subscriptionId,
          output.resourceGroup,
          output.deploymentScriptName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
