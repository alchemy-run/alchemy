import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readIotWirelessTags,
  sameShape,
  syncIotWirelessTags,
} from "./internal.ts";

export interface WirelessDeviceProps {
  /**
   * The wireless technology the device uses. Changing the type replaces the
   * device.
   */
  type: "LoRaWAN" | "Sidewalk";
  /**
   * Name of the destination that routes the device's uplink messages. Can be
   * changed in place.
   */
  destinationName: string;
  /**
   * Name of the wireless device. If omitted, a deterministic physical name
   * is generated from the app, stage, and logical ID. Can be changed in
   * place.
   */
  name?: string;
  /**
   * Human-readable description of the device.
   */
  description?: string;
  /**
   * LoRaWAN device configuration: `DevEui`, the device/service profile IDs,
   * and the activation keys (`OtaaV1_0_x`, `OtaaV1_1`, `AbpV1_0_x`,
   * `AbpV1_1`). The `DevEui` and activation keys are the device's radio
   * identity — changing them replaces the device; the profile IDs and
   * `FPorts` update in place.
   */
  loRaWAN?: iotw.LoRaWANDevice;
  /**
   * Whether position solving is enabled for the device (`Enabled` or
   * `Disabled`).
   */
  positioning?: iotw.PositioningConfigStatus;
  /**
   * Amazon Sidewalk device configuration. Changing the manufacturing serial
   * number replaces the device.
   */
  sidewalk?: iotw.SidewalkCreateWirelessDevice;
  /**
   * Tags applied to the device. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface WirelessDevice extends Resource<
  "AWS.IoTWireless.WirelessDevice",
  WirelessDeviceProps,
  {
    /** Server-assigned ID of the wireless device. */
    wirelessDeviceId: string;
    /** ARN of the wireless device. */
    wirelessDeviceArn: string;
    /** Name of the wireless device. */
    wirelessDeviceName: string;
    /** The wireless technology the device uses. */
    type: iotw.WirelessDeviceType;
    /** Name of the destination routing the device's uplinks. */
    destinationName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Core for LoRaWAN (or Amazon Sidewalk) wireless device — the
 * cloud registration of a physical radio, wired to a {@link Destination}
 * for uplink routing and to a {@link DeviceProfile} / {@link ServiceProfile}
 * pair for its radio parameters.
 *
 * The device's radio identity (`type`, `DevEui`, activation keys) is
 * immutable — changing it replaces the device. The name, description,
 * destination, positioning, profile references, and tags update in place.
 * @resource
 * @section Creating Devices
 * @example OTAA v1.0.x LoRaWAN Device
 * ```typescript
 * import * as IoTWireless from "alchemy/AWS/IoTWireless";
 *
 * const device = yield* IoTWireless.WirelessDevice("Sensor", {
 *   type: "LoRaWAN",
 *   destinationName: destination.destinationName,
 *   loRaWAN: {
 *     DevEui: "1122334455667788",
 *     DeviceProfileId: deviceProfile.deviceProfileId,
 *     ServiceProfileId: serviceProfile.serviceProfileId,
 *     OtaaV1_0_x: {
 *       AppKey: "00112233445566778899aabbccddeeff",
 *       AppEui: "8877665544332211",
 *     },
 *   },
 * });
 * ```
 *
 * @example Repoint a device at a different destination
 * ```typescript
 * const device = yield* IoTWireless.WirelessDevice("Sensor", {
 *   type: "LoRaWAN",
 *   destinationName: otherDestination.destinationName, // updates in place
 *   loRaWAN: { ... },
 * });
 * ```
 */
export const WirelessDevice = Resource<WirelessDevice>(
  "AWS.IoTWireless.WirelessDevice",
);

/** The parts of a LoRaWAN device spec that form its immutable radio identity. */
const loRaWANIdentity = (loRaWAN: iotw.LoRaWANDevice | undefined) => ({
  DevEui: loRaWAN?.DevEui,
  OtaaV1_0_x: loRaWAN?.OtaaV1_0_x,
  OtaaV1_1: loRaWAN?.OtaaV1_1,
  AbpV1_0_x: loRaWAN?.AbpV1_0_x,
  AbpV1_1: loRaWAN?.AbpV1_1,
});

export const WirelessDeviceProvider = () =>
  Provider.effect(
    WirelessDevice,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const getBy = (identifier: string, type: iotw.WirelessDeviceIdType) =>
        iotw
          .getWirelessDevice({ Identifier: identifier, IdentifierType: type })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const observe = Effect.fn(function* (
        output: WirelessDevice["Attributes"] | undefined,
        props: WirelessDeviceProps,
      ) {
        if (output?.wirelessDeviceId !== undefined) {
          const found = yield* getBy(
            output.wirelessDeviceId,
            "WirelessDeviceId",
          );
          if (found !== undefined) return found;
        }
        // Recover identity by the device's radio identifier when state was
        // lost — the DevEui / Sidewalk serial is unique per account.
        if (props.loRaWAN?.DevEui !== undefined) {
          return yield* getBy(props.loRaWAN.DevEui, "DevEui");
        }
        if (props.sidewalk?.SidewalkManufacturingSn !== undefined) {
          return yield* getBy(
            props.sidewalk.SidewalkManufacturingSn,
            "SidewalkManufacturingSn",
          );
        }
        return undefined;
      });

      const toAttrs = Effect.fn(function* (
        device: iotw.GetWirelessDeviceResponse,
        name: string,
      ) {
        if (device.Id === undefined || device.Arn === undefined) {
          return yield* Effect.fail(
            new Error(`IoT Wireless device '${name}' returned without Id/Arn`),
          );
        }
        return {
          wirelessDeviceId: device.Id,
          wirelessDeviceArn: device.Arn,
          wirelessDeviceName: device.Name ?? name,
          type: device.Type ?? "LoRaWAN",
          destinationName: device.DestinationName ?? "",
        };
      });

      return WirelessDevice.Provider.of({
        stables: ["wirelessDeviceId", "wirelessDeviceArn", "type"],

        list: () =>
          iotw.listWirelessDevices.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.WirelessDeviceList ?? [])
                .flatMap((d) =>
                  d.Id !== undefined && d.Arn !== undefined
                    ? [
                        {
                          wirelessDeviceId: d.Id,
                          wirelessDeviceArn: d.Arn,
                          wirelessDeviceName: d.Name ?? d.Id,
                          type: d.Type ?? "LoRaWAN",
                          destinationName: d.DestinationName ?? "",
                        },
                      ]
                    : [],
                ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const props = olds ?? { type: "LoRaWAN", destinationName: "" };
          const name =
            output?.wirelessDeviceName ?? (yield* createName(id, props));
          const device = yield* observe(output, props);
          if (device === undefined) return undefined;
          const attrs = yield* toAttrs(device, name);
          const tags = yield* readIotWirelessTags(attrs.wirelessDeviceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The wireless technology and the radio identity (DevEui, activation
        // keys, Sidewalk serial) are create-only. Name, description,
        // destination, positioning, and profile references update in place.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds !== undefined && olds.type !== news.type) {
            return { action: "replace" } as const;
          }
          if (
            !sameShape(
              loRaWANIdentity(olds?.loRaWAN),
              loRaWANIdentity(news.loRaWAN),
            )
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds?.sidewalk?.SidewalkManufacturingSn !==
            news.sidewalk?.SidewalkManufacturingSn
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.wirelessDeviceName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output is an id cache.
          let device = yield* observe(output, news);

          // 2. ENSURE — create if missing; a Conflict means the radio
          //    identity is already registered, so re-observe by it.
          if (device === undefined) {
            yield* session.note(`creating wireless device ${name}`);
            const created = yield* iotw
              .createWirelessDevice({
                Type: news.type,
                Name: name,
                Description: news.description,
                DestinationName: news.destinationName,
                LoRaWAN: news.loRaWAN,
                Positioning: news.positioning,
                Sidewalk: news.sidewalk,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            device =
              created?.Id !== undefined
                ? yield* getBy(created.Id, "WirelessDeviceId")
                : yield* observe(undefined, news);
          }
          if (device === undefined) {
            return yield* Effect.fail(
              new Error(`IoT Wireless device '${name}' not found after create`),
            );
          }
          const attrs = yield* toAttrs(device, name);

          // 3. SYNC — apply the mutable-aspect delta from OBSERVED state.
          const nameDelta = device.Name !== name;
          const descriptionDelta =
            news.description !== undefined &&
            device.Description !== news.description;
          const destinationDelta =
            device.DestinationName !== news.destinationName;
          const positioningDelta =
            news.positioning !== undefined &&
            device.Positioning !== news.positioning;
          const profileDelta =
            news.loRaWAN !== undefined &&
            (device.LoRaWAN?.DeviceProfileId !== news.loRaWAN.DeviceProfileId ||
              device.LoRaWAN?.ServiceProfileId !==
                news.loRaWAN.ServiceProfileId ||
              !sameShape(device.LoRaWAN?.FPorts, news.loRaWAN.FPorts));
          if (
            nameDelta ||
            descriptionDelta ||
            destinationDelta ||
            positioningDelta ||
            profileDelta
          ) {
            yield* iotw.updateWirelessDevice({
              Id: attrs.wirelessDeviceId,
              Name: name,
              Description: news.description,
              DestinationName: news.destinationName,
              Positioning: news.positioning,
              LoRaWAN:
                news.loRaWAN === undefined
                  ? undefined
                  : {
                      DeviceProfileId: news.loRaWAN.DeviceProfileId,
                      ServiceProfileId: news.loRaWAN.ServiceProfileId,
                      FPorts: news.loRaWAN.FPorts,
                    },
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags.
          yield* syncIotWirelessTags(attrs.wirelessDeviceArn, desiredTags);

          // 4. RETURN fresh attributes.
          const final = yield* getBy(
            attrs.wirelessDeviceId,
            "WirelessDeviceId",
          );
          if (final === undefined) {
            return yield* Effect.fail(
              new Error(`IoT Wireless device '${name}' vanished during update`),
            );
          }
          yield* session.note(attrs.wirelessDeviceId);
          return yield* toAttrs(final, name);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* iotw
            .deleteWirelessDevice({ Id: output.wirelessDeviceId })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
