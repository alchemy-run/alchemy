import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Entry } from "./Entry.ts";
import type { Profile } from "./Profile.ts";

/**
 * Dashboard UI providers for Cloudflare DLP (Data Loss Prevention) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ProfileUI = UIProvider.succeed<Profile>("Cloudflare.Dlp.Profile", {
  displayName: "DLP Profile",
  icon: "shield",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "profile id",
      value: ctx.attrs?.profileId,
      mono: true,
      copy: true,
    },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "description", value: ctx.attrs?.description },
    { label: "allowed matches", value: ctx.attrs?.allowedMatchCount },
    { label: "OCR", value: ctx.attrs?.ocrEnabled },
    {
      label: "entries",
      value: ctx.attrs?.entryIds
        ? Object.keys(ctx.attrs.entryIds).length
        : undefined,
    },
  ],
});

export const EntryUI = UIProvider.succeed<Entry>("Cloudflare.Dlp.Entry", {
  displayName: "DLP Entry",
  icon: "file-lock-2",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "entry id", value: ctx.attrs?.entryId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "profile", value: ctx.attrs?.profileId, mono: true },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "regex", value: ctx.attrs?.pattern?.regex, mono: true },
    { label: "validation", value: ctx.attrs?.pattern?.validation },
  ],
});

export const ui = () => Layer.mergeAll(ProfileUI, EntryUI);
