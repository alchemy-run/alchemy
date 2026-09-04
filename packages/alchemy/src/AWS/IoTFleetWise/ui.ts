import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Campaign } from "./Campaign.ts";
import type { DecoderManifest } from "./DecoderManifest.ts";
import type { Fleet } from "./Fleet.ts";
import type { ModelManifest } from "./ModelManifest.ts";
import type { SignalCatalog } from "./SignalCatalog.ts";
import type { StateTemplate } from "./StateTemplate.ts";
import type { Vehicle } from "./Vehicle.ts";

/**
 * Dashboard UI providers for AWS IoTFleetWise resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics (IoT FleetWise: signals, manifests, campaigns) brand purple. */
const COLOR = "#8C4FFF";

export const SignalCatalogUI = UIProvider.succeed<SignalCatalog>(
  "AWS.IoTFleetWise.SignalCatalog",
  {
    displayName: "IoT FleetWise Signal Catalog",
    icon: "table",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.signalCatalogName,
    facts: (ctx) => [
      { label: "catalog", value: ctx.attrs?.signalCatalogName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.signalCatalogArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ModelManifestUI = UIProvider.succeed<ModelManifest>(
  "AWS.IoTFleetWise.ModelManifest",
  {
    displayName: "IoT FleetWise Model Manifest",
    icon: "file-text",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.modelManifestName,
    facts: (ctx) => [
      { label: "manifest", value: ctx.attrs?.modelManifestName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.modelManifestArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "signal catalog",
        value: ctx.attrs?.signalCatalogArn,
        mono: true,
      },
    ],
  },
);

export const DecoderManifestUI = UIProvider.succeed<DecoderManifest>(
  "AWS.IoTFleetWise.DecoderManifest",
  {
    displayName: "IoT FleetWise Decoder Manifest",
    icon: "code",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.decoderManifestName,
    facts: (ctx) => [
      {
        label: "manifest",
        value: ctx.attrs?.decoderManifestName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.decoderManifestArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "model manifest",
        value: ctx.attrs?.modelManifestArn,
        mono: true,
      },
    ],
  },
);

export const StateTemplateUI = UIProvider.succeed<StateTemplate>(
  "AWS.IoTFleetWise.StateTemplate",
  {
    displayName: "IoT FleetWise State Template",
    icon: "layers",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.stateTemplateName,
    facts: (ctx) => [
      { label: "template", value: ctx.attrs?.stateTemplateName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.stateTemplateId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.stateTemplateArn,
        mono: true,
        copy: true,
      },
      {
        label: "signal catalog",
        value: ctx.attrs?.signalCatalogArn,
        mono: true,
      },
      {
        label: "properties",
        value: ctx.attrs?.stateTemplateProperties?.length
          ? ctx.attrs.stateTemplateProperties.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const FleetUI = UIProvider.succeed<Fleet>("AWS.IoTFleetWise.Fleet", {
  displayName: "IoT FleetWise Fleet",
  icon: "boxes",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.fleetId,
  facts: (ctx) => [
    { label: "fleet", value: ctx.attrs?.fleetId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.fleetArn, mono: true, copy: true },
    {
      label: "signal catalog",
      value: ctx.attrs?.signalCatalogArn,
      mono: true,
    },
  ],
});

export const VehicleUI = UIProvider.succeed<Vehicle>(
  "AWS.IoTFleetWise.Vehicle",
  {
    displayName: "IoT FleetWise Vehicle",
    icon: "box",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.vehicleName,
    facts: (ctx) => [
      { label: "vehicle", value: ctx.attrs?.vehicleName, copy: true },
      { label: "arn", value: ctx.attrs?.vehicleArn, mono: true, copy: true },
      {
        label: "model manifest",
        value: ctx.attrs?.modelManifestArn,
        mono: true,
      },
      {
        label: "decoder manifest",
        value: ctx.attrs?.decoderManifestArn,
        mono: true,
      },
    ],
  },
);

export const CampaignUI = UIProvider.succeed<Campaign>(
  "AWS.IoTFleetWise.Campaign",
  {
    displayName: "IoT FleetWise Campaign",
    icon: "workflow",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.campaignName,
    facts: (ctx) => [
      { label: "campaign", value: ctx.attrs?.campaignName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.campaignArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "signal catalog",
        value: ctx.attrs?.signalCatalogArn,
        mono: true,
      },
      { label: "target", value: ctx.attrs?.targetArn, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    SignalCatalogUI,
    ModelManifestUI,
    DecoderManifestUI,
    StateTemplateUI,
    FleetUI,
    VehicleUI,
    CampaignUI,
  );
