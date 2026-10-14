import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DeviceCustomProfile } from "./CustomProfile.ts";
import type { DeviceDefaultProfile } from "./DefaultProfile.ts";
import type { DeviceDexTest } from "./DexTest.ts";
import type { DeviceManagedNetwork } from "./ManagedNetwork.ts";
import type { DevicePostureIntegration } from "./PostureIntegration.ts";
import type { DevicePostureRule } from "./PostureRule.ts";
import type { DeviceSettings } from "./Settings.ts";

/**
 * Dashboard UI providers for Cloudflare Zero Trust Devices (WARP)
 * resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const DeviceCustomProfileUI = UIProvider.succeed<DeviceCustomProfile>(
  "Cloudflare.Devices.CustomProfile",
  {
    displayName: "Device Custom Profile",
    icon: "sliders-horizontal",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.policyId, mono: true, copy: true },
      { label: "match", value: ctx.attrs?.match, mono: true },
      { label: "precedence", value: ctx.attrs?.precedence },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "tunnel protocol", value: ctx.attrs?.tunnelProtocol },
      {
        label: "mode",
        value: ctx.attrs?.serviceModeV2?.mode,
      },
    ],
  },
);

export const DeviceDefaultProfileUI = UIProvider.succeed<DeviceDefaultProfile>(
  "Cloudflare.Devices.DefaultProfile",
  {
    displayName: "Device Default Profile",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.accountId,
    facts: (ctx) => [
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "split-tunnel mode", value: ctx.attrs?.mode },
      {
        label: "include routes",
        value: ctx.attrs?.splitTunnelInclude?.length || undefined,
      },
      {
        label: "exclude routes",
        value: ctx.attrs?.splitTunnelExclude?.length || undefined,
      },
      {
        label: "fallback domains",
        value: ctx.attrs?.fallbackDomains?.length || undefined,
      },
      { label: "captive portal", value: ctx.attrs?.captivePortal },
      { label: "auto connect", value: ctx.attrs?.autoConnect },
    ],
  },
);

export const DeviceDexTestUI = UIProvider.succeed<DeviceDexTest>(
  "Cloudflare.Devices.DexTest",
  {
    displayName: "Device DEX Test",
    icon: "activity",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.testId, mono: true, copy: true },
      { label: "kind", value: ctx.attrs?.data?.kind },
      { label: "host", value: ctx.attrs?.data?.host, mono: true, copy: true },
      { label: "interval", value: ctx.attrs?.interval },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const DeviceManagedNetworkUI = UIProvider.succeed<DeviceManagedNetwork>(
  "Cloudflare.Devices.ManagedNetwork",
  {
    displayName: "Device Managed Network",
    icon: "network",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.networkId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      {
        label: "tls sockaddr",
        value: ctx.attrs?.config?.tlsSockaddr,
        mono: true,
        copy: true,
      },
      {
        label: "sha256",
        value: ctx.attrs?.config?.sha256,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const DevicePostureIntegrationUI =
  UIProvider.succeed<DevicePostureIntegration>(
    "Cloudflare.Devices.PostureIntegration",
    {
      displayName: "Device Posture Integration",
      icon: "plug-zap",
      color: "#F6821F",
      category: "security",
      summary: (ctx) => ctx.attrs?.name,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name },
        {
          label: "id",
          value: ctx.attrs?.integrationId,
          mono: true,
          copy: true,
        },
        { label: "provider", value: ctx.attrs?.type },
        { label: "interval", value: ctx.attrs?.interval },
        {
          label: "api url",
          value: ctx.attrs?.config?.apiUrl,
          href: ctx.attrs?.config?.apiUrl,
          mono: true,
        },
        { label: "client id", value: ctx.attrs?.config?.clientId, mono: true },
      ],
    },
  );

export const DevicePostureRuleUI = UIProvider.succeed<DevicePostureRule>(
  "Cloudflare.Devices.PostureRule",
  {
    displayName: "Device Posture Rule",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.postureRuleId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "schedule", value: ctx.attrs?.schedule },
      { label: "expiration", value: ctx.attrs?.expiration },
      {
        label: "platforms",
        value: ctx.attrs?.match?.length
          ? ctx.attrs.match
              .map((m) => m?.platform)
              .filter((p) => p !== undefined)
              .join(", ") || undefined
          : undefined,
      },
    ],
  },
);

export const DeviceSettingsUI = UIProvider.succeed<DeviceSettings>(
  "Cloudflare.Devices.Settings",
  {
    displayName: "Device Settings",
    icon: "settings",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.accountId,
    facts: (ctx) => [
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "gateway tcp proxy", value: ctx.attrs?.gatewayProxyEnabled },
      { label: "gateway udp proxy", value: ctx.attrs?.gatewayUdpProxyEnabled },
      {
        label: "root cert install",
        value: ctx.attrs?.rootCertificateInstallationEnabled,
      },
      { label: "zt virtual ip", value: ctx.attrs?.useZtVirtualIp },
      { label: "disable for time", value: ctx.attrs?.disableForTime },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    DeviceCustomProfileUI,
    DeviceDefaultProfileUI,
    DeviceDexTestUI,
    DeviceManagedNetworkUI,
    DevicePostureIntegrationUI,
    DevicePostureRuleUI,
    DeviceSettingsUI,
  );
