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
  encodeOwnershipLine,
  expandCustomer,
  findOwned,
  getCustomerDevice,
  hasOwnershipMarker,
  ignoreMissing,
  listAllCustomerDevices,
  listCustomerDevices,
  ownedByAlchemy,
  ownershipLabels,
  replaceOnIdentity,
  sameJson,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type CustomersDeviceProps = {
  /**
   * Parent SAS customer (`customers/{customer}` or the customer id).
   * Immutable — changing it replaces the device.
   */
  customer: string;
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

export type CustomersDevice = Resource<
  "GCP.ProdTtSasportal.CustomersDevice",
  CustomersDeviceProps,
  {
    /** Full resource name `customers/{customer}/devices/{device}`. */
    name: string;
    /** Parent customer resource name. */
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
 * A Citizens Broadband Radio Service Device (CBSD) under a SAS Portal
 * customer in the production-test (prod-tt) environment.
 *
 * Devices have no labels API, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent, FCC id, serial number, and
 * resource name are identity. Display name, preloaded config, metadata,
 * and grant range allowlists update in place.
 *
 * ### Creating a Device
 * **Example:** Category A CBSD under a customer
 * ```typescript
 * const device = yield* GCP.ProdTtSasportal.CustomersDevice("Cbsd", {
 *   customer: "customers/123",
 *   displayName: "rooftop-1",
 *   fccId: "TESTFCCID",
 *   serialNumber: "SN-001",
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
 * const device = yield* GCP.ProdTtSasportal.CustomersDevice("Cbsd", {
 *   customer: existing.parent,
 *   name: existing.name,
 *   fccId: existing.fccId,
 *   serialNumber: existing.serialNumber,
 *   displayName: "rooftop-2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const CustomersDevice = Resource<CustomersDevice>(
  "GCP.ProdTtSasportal.CustomersDevice",
);

export class CustomersDeviceNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.CustomersDeviceNotResolved",
)<{
  name: string;
}> {}

export const CustomersDeviceProvider = () =>
  Provider.succeed(CustomersDevice, {
    stables: ["name", "parent", "fccId", "serialNumber"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.customer ?? output?.parent;
      return replaceOnIdentity({
        previousId: olds?.name ?? output?.name,
        nextId: news.name,
        previousParent: previousParent
          ? expandCustomer(previousParent)
          : undefined,
        nextParent: expandCustomer(news.customer),
        extra:
          (olds?.fccId !== undefined &&
            news.fccId !== undefined &&
            news.fccId !== olds.fccId) ||
          (output?.fccId !== undefined &&
            news.fccId !== undefined &&
            news.fccId !== output.fccId) ||
          (olds?.serialNumber !== undefined &&
            news.serialNumber !== undefined &&
            news.serialNumber !== olds.serialNumber) ||
          (output?.serialNumber !== undefined &&
            news.serialNumber !== undefined &&
            news.serialNumber !== output.serialNumber),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const parent = expandCustomer(olds?.customer ?? output?.parent ?? "");
      const name = olds?.name ?? output?.name ?? "";
      let existing = yield* getCustomerDevice(name);
      if (existing === undefined) {
        existing = yield* findOwned(yield* listCustomerDevices(parent), id);
      }
      if (existing === undefined) return undefined;
      const attrs = deviceAttrs(existing, parent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const items = yield* listAllCustomerDevices();
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => deviceAttrs(item, ""));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = expandCustomer(news.customer);
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

      let current = yield* getCustomerDevice(name);
      if (current === undefined) {
        current = yield* findOwned(yield* listCustomerDevices(parent), id);
      }

      if (current === undefined) {
        const created = yield* sas
          .createCustomersDevices({ parent, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listCustomerDevices(parent).pipe(
                Effect.flatMap((items) => findOwned(items, id)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersDeviceNotResolved({
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
        current = yield* sas.patchCustomersDevices({
          name: currentName,
          updateMask,
          body,
        });
      }

      return deviceAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(sas.deleteCustomersDevices({ name: output.name }));
    }),
  });
