import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ManagedTransforms } from "./ManagedTransforms.ts";

/**
 * Dashboard UI providers for Cloudflare Managed Transforms resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ManagedTransformsUI = UIProvider.succeed<ManagedTransforms>(
  "Cloudflare.ManagedTransforms.ManagedTransforms",
  {
    displayName: "Managed Transforms",
    icon: "replace",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "request transforms enabled",
        value: ctx.attrs?.requestHeaders?.filter((t) => t?.enabled).length,
      },
      {
        label: "response transforms enabled",
        value: ctx.attrs?.responseHeaders?.filter((t) => t?.enabled).length,
      },
      {
        label: "managed request headers",
        value: ctx.props?.requestHeaders
          ? Object.keys(ctx.props.requestHeaders).join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "managed response headers",
        value: ctx.props?.responseHeaders
          ? Object.keys(ctx.props.responseHeaders).join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(ManagedTransformsUI);
