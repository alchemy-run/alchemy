import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { SecurityTxt } from "./SecurityTxt.ts";

/**
 * Dashboard UI providers for Cloudflare SecurityTxt resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const SecurityTxtUI = UIProvider.succeed<SecurityTxt>(
  "Cloudflare.SecurityTxt.SecurityTxt",
  {
    displayName: "security.txt",
    icon: "file-lock-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.contact?.length
        ? ctx.attrs.contact[0]
        : ctx.props?.contact?.[0],
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "enabled",
        value:
          ctx.attrs?.enabled === undefined
            ? undefined
            : ctx.attrs.enabled
              ? "yes"
              : "no",
      },
      {
        label: "contact",
        value: ctx.attrs?.contact?.length
          ? ctx.attrs.contact.join(", ")
          : undefined,
        copy: true,
      },
      { label: "expires", value: ctx.attrs?.expires },
      {
        label: "canonical",
        value: ctx.attrs?.canonical?.length
          ? ctx.attrs.canonical.join(", ")
          : undefined,
      },
      {
        label: "policy",
        value: ctx.attrs?.policy?.length
          ? ctx.attrs.policy.join(", ")
          : undefined,
      },
      { label: "languages", value: ctx.attrs?.preferredLanguages },
    ],
  },
);

export const ui = () => Layer.mergeAll(SecurityTxtUI);
