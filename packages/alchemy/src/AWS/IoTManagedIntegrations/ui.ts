import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CredentialLocker } from "./CredentialLocker.ts";
import type { Destination } from "./Destination.ts";
import type { ManagedThing } from "./ManagedThing.ts";
import type { NotificationConfiguration } from "./NotificationConfiguration.ts";

/**
 * Dashboard UI providers for AWS IoT Managed Integrations resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const CredentialLockerUI = UIProvider.succeed<CredentialLocker>(
  "AWS.IoTManagedIntegrations.CredentialLocker",
  {
    displayName: "IoT Credential Locker",
    icon: "lock",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.credentialLockerName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.credentialLockerName, copy: true },
      { label: "id", value: ctx.attrs?.credentialLockerId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.credentialLockerArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const DestinationUI = UIProvider.succeed<Destination>(
  "AWS.IoTManagedIntegrations.Destination",
  {
    displayName: "IoT Managed Integrations Destination",
    icon: "send",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.destinationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.destinationName, copy: true },
      {
        label: "delivery arn",
        value: ctx.attrs?.deliveryDestinationArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.deliveryDestinationType },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const ManagedThingUI = UIProvider.succeed<ManagedThing>(
  "AWS.IoTManagedIntegrations.ManagedThing",
  {
    displayName: "IoT Managed Thing",
    icon: "cpu",
    color: "#8C4FFF",
    category: "network",
    summary: (ctx) => ctx.attrs?.managedThingName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.managedThingName, copy: true },
      { label: "id", value: ctx.attrs?.managedThingId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.managedThingArn,
        mono: true,
        copy: true,
      },
      { label: "role", value: ctx.attrs?.role },
      { label: "status", value: ctx.attrs?.provisioningStatus },
    ],
  },
);

export const NotificationConfigurationUI =
  UIProvider.succeed<NotificationConfiguration>(
    "AWS.IoTManagedIntegrations.NotificationConfiguration",
    {
      displayName: "IoT Notification Configuration",
      icon: "bell",
      color: "#E7157B",
      category: "eventing",
      summary: (ctx) => ctx.attrs?.eventType,
      facts: (ctx) => [
        { label: "event type", value: ctx.attrs?.eventType, copy: true },
        { label: "destination", value: ctx.attrs?.destinationName },
        {
          label: "arn",
          value: ctx.attrs?.notificationConfigurationArn,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    CredentialLockerUI,
    DestinationUI,
    ManagedThingUI,
    NotificationConfigurationUI,
  );
