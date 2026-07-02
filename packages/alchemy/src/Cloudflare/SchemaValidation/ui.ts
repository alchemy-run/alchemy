import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { OperationSetting } from "./OperationSetting.ts";
import type { SchemaValidationSchema } from "./Schema.ts";
import type { Settings } from "./Settings.ts";

/**
 * Dashboard UI providers for Cloudflare SchemaValidation resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const SchemaUI = UIProvider.succeed<SchemaValidationSchema>(
  "Cloudflare.SchemaValidation.Schema",
  {
    displayName: "Schema Validation Schema",
    icon: "file-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    facts: (ctx) => [
      {
        label: "schema id",
        value: ctx.attrs?.schemaId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "kind", value: ctx.attrs?.kind },
      {
        label: "validation",
        value:
          ctx.attrs?.validationEnabled === undefined
            ? undefined
            : ctx.attrs.validationEnabled
              ? "enabled"
              : "disabled",
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const SettingsUI = UIProvider.succeed<Settings>(
  "Cloudflare.SchemaValidation.Settings",
  {
    displayName: "Schema Validation Settings",
    icon: "settings-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.validationDefaultMitigationAction ??
      ctx.props?.validationDefaultMitigationAction,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "default action",
        value: ctx.attrs?.validationDefaultMitigationAction,
      },
      {
        label: "override action",
        value: ctx.attrs?.validationOverrideMitigationAction ?? undefined,
      },
    ],
  },
);

export const OperationSettingUI = UIProvider.succeed<OperationSetting>(
  "Cloudflare.SchemaValidation.OperationSetting",
  {
    displayName: "Schema Validation Operation Setting",
    icon: "sliders-horizontal",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.mitigationAction ?? ctx.props?.mitigationAction,
    facts: (ctx) => [
      {
        label: "operation id",
        value: ctx.attrs?.operationId,
        mono: true,
        copy: true,
      },
      { label: "mitigation action", value: ctx.attrs?.mitigationAction },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(SchemaUI, SettingsUI, OperationSettingUI);
