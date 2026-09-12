import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Destination } from "./Destination.ts";
import type { DeviceProfile } from "./DeviceProfile.ts";
import type { ServiceProfile } from "./ServiceProfile.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";
import type { WirelessGateway } from "./WirelessGateway.ts";

/**
 * Dashboard UI providers for AWS IoTWireless resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const DestinationUI = UIProvider.succeed<Destination>(
  "AWS.IoTWireless.Destination",
  {
    displayName: "IoT Wireless Destination",
    icon: "route",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.destinationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.destinationName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.destinationArn,
        mono: true,
        copy: true,
      },
      { label: "expression type", value: ctx.attrs?.expressionType },
      { label: "expression", value: ctx.attrs?.expression, mono: true },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
    ],
  },
);

export const DeviceProfileUI = UIProvider.succeed<DeviceProfile>(
  "AWS.IoTWireless.DeviceProfile",
  {
    displayName: "IoT Wireless Device Profile",
    icon: "cpu",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.deviceProfileName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.deviceProfileName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.deviceProfileArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.deviceProfileId, mono: true },
    ],
  },
);

export const ServiceProfileUI = UIProvider.succeed<ServiceProfile>(
  "AWS.IoTWireless.ServiceProfile",
  {
    displayName: "IoT Wireless Service Profile",
    icon: "settings",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.serviceProfileName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.serviceProfileName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.serviceProfileArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.serviceProfileId, mono: true },
    ],
  },
);

export const WirelessDeviceUI = UIProvider.succeed<WirelessDevice>(
  "AWS.IoTWireless.WirelessDevice",
  {
    displayName: "IoT Wireless Device",
    icon: "radio",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.wirelessDeviceName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.wirelessDeviceName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.wirelessDeviceArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.wirelessDeviceId, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "destination", value: ctx.attrs?.destinationName, mono: true },
    ],
  },
);

export const WirelessGatewayUI = UIProvider.succeed<WirelessGateway>(
  "AWS.IoTWireless.WirelessGateway",
  {
    displayName: "IoT Wireless Gateway",
    icon: "cable",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.wirelessGatewayName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.wirelessGatewayName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.wirelessGatewayArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.wirelessGatewayId, mono: true },
      { label: "gateway eui", value: ctx.attrs?.gatewayEui, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    DestinationUI,
    DeviceProfileUI,
    ServiceProfileUI,
    WirelessDeviceUI,
    WirelessGatewayUI,
  );
