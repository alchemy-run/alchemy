import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Organization } from "./Organization.ts";

/**
 * Dashboard UI providers for Cloudflare Organization resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const OrganizationUI = UIProvider.succeed<Organization>(
  "Cloudflare.Organization.Organization",
  {
    displayName: "Organization",
    icon: "network",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "org id",
        value: ctx.attrs?.organizationId,
        mono: true,
        copy: true,
      },
      { label: "parent", value: ctx.attrs?.parent?.name },
      { label: "parent id", value: ctx.attrs?.parent?.id, mono: true },
      { label: "managed by", value: ctx.attrs?.managedBy },
      { label: "created", value: ctx.attrs?.createTime },
    ],
  },
);

export const ui = () => Layer.mergeAll(OrganizationUI);
