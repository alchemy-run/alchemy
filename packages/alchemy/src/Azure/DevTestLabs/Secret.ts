import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  labLocation,
} from "./Common.ts";

export interface SecretProps {
  /** Resource group of the lab. Changing it replaces the secret. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the secret. */
  lab: string;
  /** Name of the lab user that owns the secret. Changing it replaces the secret. */
  user: string;
  /**
   * Secret name (letters, digits, and `-`). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the secret.
   */
  name?: string;
  /**
   * Secret value. Azure never returns it, so a change is detected against
   * the previous deploy.
   */
  value: Redacted.Redacted<string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Secret extends Resource<
  "Azure.DevTestLabs.Secret",
  SecretProps,
  {
    /** Name of the secret. */
    secretName: string;
    /** ARM resource ID of the secret. */
    secretId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Name of the lab user that owns the secret. */
    user: string;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A secret in a DevTest Labs user's secret store (the lab's Key Vault),
 * e.g. a VM password or a repository token that lab formulas and
 * environments reference by name.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-store-secrets-in-key-vault
 *
 * ### Storing a Secret
 * **Example:** VM password for lab formulas
 * ```typescript
 * const password = yield* Azure.DevTestLabs.Secret("vm-password", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   user: user.userName,
 *   value: Redacted.make(vmPassword),
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Azure.DevTestLabs.Secret");

const getSecret = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetSecret({
      subscriptionId,
      resourceGroupName,
      labName,
      userName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  user: string,
  name: string,
  s: devtestlabs.GetSecretResponse,
): Secret["Attributes"] => ({
  secretName: name,
  secretId: s.id ?? "",
  resourceGroup,
  lab,
  user,
  uniqueIdentifier: s.properties?.uniqueIdentifier,
  tags: userTags(s.tags),
});

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["secretName", "secretId", "resourceGroup", "lab", "user"],

    // Secrets are deleted with their lab user.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.user.toLowerCase() !== output.user.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.secretName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      const user = output?.user ?? olds?.user;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        user === undefined
      ) {
        return undefined;
      }
      const name =
        output?.secretName ?? olds?.name ?? (yield* createLabResourceName(id));
      const observed = yield* getSecret(
        subscriptionId,
        resourceGroup,
        lab,
        user,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, user, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab, user } = news;
      const name =
        news.name ?? output?.secretName ?? (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const value = Redacted.value(news.value);
      const get = getSecret(subscriptionId, resourceGroup, lab, user, name);
      const wait = waitForProvisioned(
        `lab secret ${name}`,
        get,
        (s) => s.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync: the value is write-only, so a rotation is detected
      // against the previous props; the PUT is a long-running upsert.
      if (
        observed === undefined ||
        olds === undefined ||
        value !== Redacted.value(olds.value) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.SecretsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          userName: user,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties: { value },
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, user, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteSecret({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          userName: output.user,
          name: output.secretName,
        }),
      );
      yield* waitUntilGone(
        `lab secret ${output.secretName}`,
        getSecret(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.user,
          output.secretName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
