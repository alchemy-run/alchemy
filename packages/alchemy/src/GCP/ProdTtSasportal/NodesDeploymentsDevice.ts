import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  deviceAttrs,
  deviceBody,
  deviceReplaceExtra,
  encodeOwnershipLine,
  expandDeployment,
  findOwned,
  getDeploymentDevice,
  hasOwnershipMarker,
  ignoreMissing,
  listAllNodeDeploymentDevices,
  listNodeDeploymentsDevices,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameJson,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type NodesDeploymentsDeviceProps = {
  /**
   * Parent SAS node deployment (`nodes/{node}/deployments/{deployment}`).
   * Immutable — changing it replaces the device.
   */
  deployment: string;
  /**
   * Full resource name. Server-assigned on create. Immutable — changing
   * it replaces the device.
   */
  name?: string;
  /**
   * Human-readable name. Devices have no labels field, so Alchemy
   * stamps ownership into this field.
   */
  displayName?: string;
  /**
   * FCC identifier of the CBSD. Immutable — changing it replaces the
   * device.
   */
  fccId?: string;
  /**
   * Manufacturer serial number. Immutable — changing it replaces the
   * device.
   */
  serialNumber?: string;
  /**
   * Portal-side device configuration (category, air interface, model).
   */
  preloadedConfig?: sas.SasPortalDeviceConfig;
  /**
   * Device parameters overridable by SAS Portal and registration.
   */
  deviceMetadata?: sas.SasPortalDeviceMetadata;
  /**
   * Frequency ranges allowed for new grants.
   */
  grantRangeAllowlists?: sas.SasPortalFrequencyRange[];
};

export type NodesDeploymentsDevice = Resource<
  "GCP.ProdTtSasportal.NodesDeploymentsDevice",
  NodesDeploymentsDeviceProps,
  {
    /** Full resource name. */
    name: string;
    /** Parent resource name. */
    parent: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** FCC identifier. */
    fccId: string | undefined;
    /** Manufacturer serial number. */
    serialNumber: string | undefined;
    /** Server-reported device state. */
    state: string | undefined;
    /** Portal-side configuration. */
    preloadedConfig: sas.SasPortalDeviceConfig | undefined;
    /** Registered SAS configuration. */
    activeConfig: sas.SasPortalDeviceConfig | undefined;
    /** Overridable device metadata. */
    deviceMetadata: sas.SasPortalDeviceMetadata | undefined;
    /** Grant range allowlists. */
    grantRangeAllowlists: sas.SasPortalFrequencyRange[] | undefined;
    /** Grants held by the device. */
    grants: sas.SasPortalDeviceGrant[] | undefined;
    /** Current channels with scores. */
    currentChannels: sas.SasPortalChannelWithScore[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Citizens Broadband Radio Service Device (CBSD) under a SAS Portal node deployment in the production-test (prod-tt) environment.
 *
 * Devices have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent, FCC id, serial number, and
 * resource name are identity. Display name, preloaded config, metadata,
 * and grant range allowlists update in place.
 *
 * ### Creating a Device
 * **Example:** Category A CBSD
 * ```typescript
 * const device = yield* GCP.ProdTtSasportal.NodesDeploymentsDevice("Cbsd", {
 *   deployment: deployment.name,
 *   displayName: "yard-ap",
 *   fccId: "TESTFCCID",
 *   serialNumber: "ALCHEMY-ND-1",
 *   preloadedConfig: {
 *     category: "DEVICE_CATEGORY_A",
 *     userId: "user-1",
 *   },
 * });
 * ```
 *
 * ### Updating a Device
 * **Example:** Change the display name
 * ```typescript
 * const device = yield* GCP.ProdTtSasportal.NodesDeploymentsDevice("Cbsd", {
 *   deployment: existing.parent,
 *   name: existing.name,
 *   fccId: existing.fccId,
 *   serialNumber: existing.serialNumber,
 *   displayName: "yard-ap-2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const NodesDeploymentsDevice = Resource<NodesDeploymentsDevice>(
  "GCP.ProdTtSasportal.NodesDeploymentsDevice",
);

export class NodesDeploymentsDeviceNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.NodesDeploymentsDeviceNotResolved",
)<{
  name: string;
}> {}

export const NodesDeploymentsDeviceProvider = () =>
  Provider.succeed(NodesDeploymentsDevice, {
    stables: ["name", "parent", "fccId", "serialNumber"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.deployment ?? output?.parent;
      return replaceOnIdentity({
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
        previousParent: previousParent
          ? expandDeployment(previousParent)
          : undefined,
        nextParent: expandDeployment(news.deployment),
        extra: deviceReplaceExtra(news, olds, output),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const parent = expandDeployment(olds?.deployment ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getDeploymentDevice(name);
      if (existing === undefined) {
        existing = yield* findOwned(
          yield* listNodeDeploymentsDevices(parent),
          id,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = deviceAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllNodeDeploymentDevices();
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => deviceAttrs(item, ""));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = expandDeployment(news.deployment);
      const name = news.name ?? output?.name ?? "";
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        yield* toDisplayName(id, news.displayName),
      );
      const body = deviceBody({
        displayName,
        fccId: news.fccId,
        serialNumber: news.serialNumber,
        preloadedConfig: news.preloadedConfig,
        deviceMetadata: news.deviceMetadata,
        grantRangeAllowlists: news.grantRangeAllowlists,
      });

      let current = yield* getDeploymentDevice(name);
      if (current === undefined) {
        current = yield* findOwned(
          yield* listNodeDeploymentsDevices(parent),
          id,
        );
      }

      if (current === undefined) {
        const created = yield* sas
          .createNodesDeploymentsDevices({ parent, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listNodeDeploymentsDevices(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new NodesDeploymentsDeviceNotResolved({
          name: name || parent,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const configChanged =
        news.preloadedConfig !== undefined &&
        !sameJson(current.preloadedConfig, news.preloadedConfig);
      const metadataChanged =
        news.deviceMetadata !== undefined &&
        !sameJson(current.deviceMetadata, news.deviceMetadata);
      const allowlistsChanged =
        news.grantRangeAllowlists !== undefined &&
        !sameJson(current.grantRangeAllowlists, news.grantRangeAllowlists);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        configChanged ? "preloadedConfig" : undefined,
        metadataChanged ? "deviceMetadata" : undefined,
        allowlistsChanged ? "grantRangeAllowlists" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* sas.patchDeploymentsDevices({
          name: currentName,
          updateMask,
          body,
        });
      }

      return deviceAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(sas.deleteDeploymentsDevices({ name: output.name }));
    }),
  });
