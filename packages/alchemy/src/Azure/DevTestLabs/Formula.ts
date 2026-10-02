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
  diverges,
  labLocation,
  vmSettingsInput,
} from "./Common.ts";

/** Marketplace image of a lab VM. */
export interface LabGalleryImageReference {
  /** Image publisher, e.g. `"Canonical"`. */
  publisher: string;
  /** Image offer, e.g. `"0001-com-ubuntu-server-jammy"`. */
  offer: string;
  /** Image SKU, e.g. `"22_04-lts-gen2"`. */
  sku: string;
  /** OS type, `"Linux"` or `"Windows"`. */
  osType: string;
  /**
   * Image version.
   * @default "latest"
   */
  version?: string;
}

/** An artifact to install on a lab VM. */
export interface LabArtifactInstall {
  /** ARM ID of the artifact. */
  artifactId: string;
  /** Artifact parameters. */
  parameters?: { name: string; value: string }[];
}

/** VM settings captured by a formula. */
export interface FormulaVmSettings {
  /** VM size, e.g. `"Standard_B1s"`. */
  size?: string;
  /** Marketplace image of the VM. */
  galleryImageReference?: LabGalleryImageReference;
  /** ARM ID of a lab custom image (instead of a gallery image). */
  customImageId?: string;
  /** Admin user name. */
  userName?: string;
  /** Admin password. Azure never returns it; a change is detected against the previous deploy. */
  password?: Redacted.Redacted<string>;
  /** SSH public key (Linux). */
  sshKey?: string;
  /** Whether the VM authenticates with `sshKey` instead of a password. */
  isAuthenticationWithSshKey?: boolean;
  /** ARM ID of the lab virtual network. */
  labVirtualNetworkId?: string;
  /** Lab subnet name. */
  labSubnetName?: string;
  /** Whether the VM gets no public IP. */
  disallowPublicIpAddress?: boolean;
  /** OS disk storage type (`Standard`, `Premium`, `StandardSSD`). */
  storageType?: string;
  /** Whether lab users can claim the VM. */
  allowClaim?: boolean;
  /** Notes shown on the VM. */
  notes?: string;
  /** Artifacts installed at creation. */
  artifacts?: LabArtifactInstall[];
}

export interface FormulaProps {
  /** Resource group of the lab. Changing it replaces the formula. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the formula. */
  lab: string;
  /**
   * Formula name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the formula.
   */
  name?: string;
  /** Description of the formula. */
  description?: string;
  /** OS type of VMs created from the formula (`Linux` or `Windows`). */
  osType?: string;
  /** VM settings of the formula. */
  formulaContent?: FormulaVmSettings;
  /**
   * ARM ID of an existing lab VM to capture the formula from. Changing it
   * replaces the formula.
   */
  labVmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Formula extends Resource<
  "Azure.DevTestLabs.Formula",
  FormulaProps,
  {
    /** Name of the formula. */
    formulaName: string;
    /** ARM resource ID of the formula. */
    formulaId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Author of the formula. */
    author: string | undefined;
    /** OS type of the formula. */
    osType: string | undefined;
    /** Creation time of the formula. */
    creationDate: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs formula — a reusable template of VM settings (image,
 * size, network, artifacts) that lab users create VMs from.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-manage-formulas
 *
 * ### Creating a Formula
 * **Example:** Ubuntu VM formula
 * ```typescript
 * const formula = yield* Azure.DevTestLabs.Formula("ubuntu", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   description: "Ubuntu 22.04 dev box",
 *   osType: "Linux",
 *   formulaContent: {
 *     size: "Standard_B1s",
 *     galleryImageReference: {
 *       publisher: "Canonical",
 *       offer: "0001-com-ubuntu-server-jammy",
 *       sku: "22_04-lts-gen2",
 *       osType: "Linux",
 *     },
 *     userName: "azureuser",
 *     isAuthenticationWithSshKey: true,
 *     sshKey: publicKey,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Formula = Resource<Formula>("Azure.DevTestLabs.Formula");

const getFormula = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetFormulas({
      subscriptionId,
      resourceGroupName,
      labName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  f: devtestlabs.GetFormulasResponse,
): Formula["Attributes"] => ({
  formulaName: name,
  formulaId: f.id ?? "",
  resourceGroup,
  lab,
  author: f.properties?.author,
  osType: f.properties?.osType,
  creationDate: f.properties?.creationDate,
  uniqueIdentifier: f.properties?.uniqueIdentifier,
  tags: userTags(f.tags),
});

const passwordOf = (settings: FormulaVmSettings | undefined) =>
  settings?.password === undefined
    ? undefined
    : Redacted.value(settings.password);

export const FormulaProvider = () =>
  Provider.succeed(Formula, {
    stables: ["formulaName", "formulaId", "resourceGroup", "lab"],

    // Formulas are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.formulaName.toLowerCase()) ||
        news.labVmId?.toLowerCase() !== olds?.labVmId?.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name =
        output?.formulaName ?? olds?.name ?? (yield* createLabResourceName(id));
      const observed = yield* getFormula(
        subscriptionId,
        resourceGroup,
        lab,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name =
        news.name ?? output?.formulaName ?? (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const content =
        news.formulaContent === undefined
          ? undefined
          : vmSettingsInput(news.formulaContent);
      const desired = {
        description: news.description,
        osType: news.osType,
        formulaContent:
          content === undefined ? undefined : { properties: content },
        vm: news.labVmId === undefined ? undefined : { labVmId: news.labVmId },
      };
      const password = passwordOf(news.formulaContent);
      const get = getFormula(subscriptionId, resourceGroup, lab, name);
      const wait = waitForProvisioned(
        `lab formula ${name}`,
        get,
        (f) => f.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync: the PUT is a long-running full upsert; the password
      // is write-only and compared against the previous props.
      if (
        observed === undefined ||
        diverges(desired, observed.properties) ||
        password !== passwordOf(olds?.formulaContent) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.FormulasCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties: {
            ...desired,
            formulaContent:
              content === undefined
                ? undefined
                : { properties: { ...content, password } },
          },
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteFormulas({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.formulaName,
        }),
      );
      yield* waitUntilGone(
        `lab formula ${output.formulaName}`,
        getFormula(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.formulaName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
