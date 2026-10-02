import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createComputeName, sameId, waitComputeGone } from "./common.ts";

export interface SshPublicKeyProps {
  /**
   * Resource group the key is created in. Changing it replaces the key.
   */
  resourceGroup: string;
  /**
   * Name of the SSH public key resource: 1-128 letters, digits, `_`, `.`,
   * and `-`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the key.
   */
  name?: string;
  /**
   * Azure location of the key. Changing it replaces the key.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * OpenSSH public key (`ssh-rsa ...` or `ssh-ed25519 ...`). Changing it
   * rotates the stored key in place. Omit it and set `generateKeyPair` to
   * let Azure generate a key pair.
   */
  publicKey?: string;
  /**
   * Have Azure generate the key pair when the resource is created. The
   * private key is returned exactly once and kept as the secret
   * `privateKey` attribute. Ignored when `publicKey` is set.
   * @default false
   */
  generateKeyPair?: boolean;
  /**
   * Algorithm of a generated key pair. Changing it replaces the key.
   * @default "RSA"
   */
  encryptionType?: "RSA" | "Ed25519";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SshPublicKey extends Resource<
  "Azure.Compute.SshPublicKey",
  SshPublicKeyProps,
  {
    /** Name of the SSH public key resource. */
    sshPublicKeyName: string;
    /** ARM resource ID of the key. */
    sshPublicKeyId: string;
    /** Resource group that holds the key. */
    resourceGroup: string;
    /** Location of the key. */
    location: string;
    /** The stored OpenSSH public key. */
    publicKey: string | undefined;
    /**
     * Private key of an Azure-generated key pair. Only available for keys
     * this stack generated; Azure never returns it again.
     */
    privateKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SSH public key resource — stores an OpenSSH public key in Azure
 * so VMs can reference it, or has Azure generate a key pair. SSH key
 * resources are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/ssh-keys-portal
 *
 * ### Storing an Existing Key
 * **Example:** Upload a public key
 * ```typescript
 * const key = yield* Azure.Compute.SshPublicKey("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   publicKey: "ssh-ed25519 AAAAC3Nza... admin@example.com",
 * });
 * ```
 *
 * ### Generating a Key Pair
 * **Example:** Let Azure generate the pair
 * ```typescript
 * const key = yield* Azure.Compute.SshPublicKey("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   generateKeyPair: true,
 * });
 * // key.privateKey is a Redacted<string>
 * ```
 *
 * ### Using the Key on a VM
 * **Example:** VM that trusts the key
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("web", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [key.publicKey.as<string>()],
 * });
 * ```
 *
 * @resource
 */
export const SshPublicKey = Resource<SshPublicKey>(
  "Azure.Compute.SshPublicKey",
);

type Observed = compute.GetSshPublicKeyResponse;

const getKey = (
  subscriptionId: string,
  resourceGroupName: string,
  sshPublicKeyName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetSshPublicKey({
      subscriptionId,
      resourceGroupName,
      sshPublicKeyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  key: Observed,
  privateKey: Redacted.Redacted<string> | undefined,
): SshPublicKey["Attributes"] => ({
  sshPublicKeyName: name,
  sshPublicKeyId: key.id ?? "",
  resourceGroup,
  location: key.location,
  publicKey: key.properties?.publicKey,
  privateKey,
  tags: userTags(key.tags),
});

/** Compare OpenSSH keys ignoring the trailing comment and whitespace. */
const keyBody = (key: string | undefined) =>
  key?.trim().split(/\s+/).slice(0, 2).join(" ");

export const SshPublicKeyProvider = () =>
  Provider.succeed(SshPublicKey, {
    stables: [
      "sshPublicKeyName",
      "sshPublicKeyId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListSshPublicKeyBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSshPublicKeyBySubscription", page),
          ),
        );
      return page.value.flatMap((key) => {
        const resourceGroup = resourceGroupOf(key.id);
        return hasAnyAlchemyTag(key.tags) &&
          resourceGroup !== undefined &&
          key.name !== undefined
          ? [toAttrs(resourceGroup, key.name, key, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.sshPublicKeyName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        // A generated pair cannot be re-generated in place.
        (news.publicKey === undefined &&
          (news.generateKeyPair ?? false) !==
            (olds?.generateKeyPair ?? false)) ||
        (news.generateKeyPair === true &&
          (news.encryptionType ?? "RSA") !== (olds?.encryptionType ?? "RSA"))
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
        output?.sshPublicKeyName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getKey(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed, output?.privateKey);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.sshPublicKeyName ?? (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sshPublicKeyName: name,
      };
      let privateKey = output?.privateKey;

      // Observe.
      let observed = yield* getKey(subscriptionId, resourceGroup, name);

      // Ensure.
      if (observed === undefined) {
        observed = yield* compute.CreateSshPublicKey({
          ...where,
          location,
          tags,
          properties:
            news.publicKey === undefined
              ? undefined
              : { publicKey: news.publicKey },
        });
      }

      // A key resource without a public key gets a generated pair once.
      if (
        news.publicKey === undefined &&
        news.generateKeyPair === true &&
        !observed.properties?.publicKey
      ) {
        const pair = yield* compute.GenerateSshPublicKeyKeyPair({
          ...where,
          encryptionType: news.encryptionType ?? "RSA",
        });
        privateKey =
          typeof pair.privateKey === "string"
            ? Redacted.make(pair.privateKey)
            : pair.privateKey;
        observed =
          (yield* getKey(subscriptionId, resourceGroup, name)) ?? observed;
      }

      // Sync the public key and tags against observed state.
      const keyChanged =
        news.publicKey !== undefined &&
        keyBody(observed.properties?.publicKey) !== keyBody(news.publicKey);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (keyChanged || tagsChanged) {
        observed = yield* compute.UpdateSshPublicKey({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: keyChanged ? { publicKey: news.publicKey } : undefined,
        });
      }
      if (news.publicKey !== undefined) privateKey = undefined;
      return toAttrs(resourceGroup, name, observed, privateKey);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteSshPublicKey({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sshPublicKeyName: output.sshPublicKeyName,
        }),
      );
      yield* waitComputeGone(
        `SSH public key ${output.sshPublicKeyName}`,
        getKey(subscriptionId, output.resourceGroup, output.sshPublicKeyName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
