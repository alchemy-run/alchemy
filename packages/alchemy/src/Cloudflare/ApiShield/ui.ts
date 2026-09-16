import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Label } from "./Label.ts";
import type { Operation } from "./Operation.ts";
import type { UserSchema } from "./UserSchema.ts";

/**
 * Dashboard UI providers for Cloudflare ApiShield resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const OperationUI = UIProvider.succeed<Operation>(
  "Cloudflare.ApiShield.Operation",
  {
    displayName: "API Shield Operation",
    icon: "route",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.method !== undefined && ctx.attrs?.endpoint !== undefined
        ? `${ctx.attrs.method} ${ctx.attrs.host ?? ""}${ctx.attrs.endpoint}`
        : ctx.props?.endpoint,
    facts: (ctx) => [
      {
        label: "operation id",
        value: ctx.attrs?.operationId,
        mono: true,
        copy: true,
      },
      {
        label: "method",
        value: ctx.attrs?.method ?? ctx.props?.method,
        mono: true,
      },
      { label: "host", value: ctx.attrs?.host ?? ctx.props?.host, copy: true },
      {
        label: "endpoint",
        value: ctx.attrs?.endpoint ?? ctx.props?.endpoint,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "last updated", value: ctx.attrs?.lastUpdated },
    ],
  },
);

export const LabelUI = UIProvider.succeed<Label>("Cloudflare.ApiShield.Label", {
  displayName: "API Shield Label",
  icon: "tag",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "description", value: ctx.attrs?.description },
    { label: "source", value: ctx.attrs?.source },
    { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const UserSchemaUI = UIProvider.succeed<UserSchema>(
  "Cloudflare.ApiShield.UserSchema",
  {
    displayName: "API Shield User Schema",
    icon: "file-code",
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

export const ui = () => Layer.mergeAll(OperationUI, LabelUI, UserSchemaUI);
