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

export type SignedCustomersDeviceProps = {
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
   * stamps ownership into this field after the signed create.
   */
  displayName?: string;
  /**
   * JSON Web Token signed with a CPI private key. Payload is the JSON
   * encoding of the device and must include `userId`. Used on create
   * only.
   */
  encodedDevice: string;
  /**
   * Unique Certified Professional Installer id. Used on create only.
   */
  installerId: string;
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

export type SignedCustomersDevice = Resource<
  "GCP.ProdTtSasportal.SignedCustomersDevice",
  SignedCustomersDeviceProps,
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
 * A CPI-signed Citizens Broadband Radio Service Device (CBSD) under a SAS Portal customer in the production-test (prod-tt) environment.
 *
 * Create uses `devices:createSigned` with a CPI-signed JWT. After
 * create the device is a normal CBSD: Alchemy stamps ownership into
 * `displayName` for `list` / nuke, and display name / config / metadata
 * / grant range allowlists update in place via patch. Parent and
 * resource name are identity. The JWT and installer id are create-only.
 *
 * ### Creating a Signed Device
 * **Example:** CPI-signed CBSD
 * ```typescript
 * const device = yield* GCP.ProdTtSasportal.SignedCustomersDevice("Cbsd", {
 *   customer: parent.name,
 *   encodedDevice: jwt,
 *   installerId: "CPI-123",
 *   displayName: "rooftop-1",
 * });
 * ```
 *
 * ### Updating a Signed Device
 * **Example:** Change the display name
 * ```typescript
 * const device = yield* GCP.ProdTtSasportal.SignedCustomersDevice("Cbsd", {
 *   customer: existing.parent,
 *   name: existing.name,
 *   encodedDevice: jwt,
 *   installerId: "CPI-123",
 *   displayName: "rooftop-2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ProdTtSasportal
 */
export const SignedCustomersDevice = Resource<SignedCustomersDevice>(
  "GCP.ProdTtSasportal.SignedCustomersDevice",
);

export class SignedCustomersDeviceNotResolved extends Data.TaggedError(
  "GCP.ProdTtSasportal.SignedCustomersDeviceNotResolved",
)<{
  name: string;
}> {}

export const SignedCustomersDeviceProvider = () =>
  Provider.succeed(SignedCustomersDevice, {
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
          .createSignedCustomersDevices({
            parent,
            body: {
              encodedDevice: news.encodedDevice,
              installerId: news.installerId,
            },
          })
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
        return yield* new SignedCustomersDeviceNotResolved({
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
