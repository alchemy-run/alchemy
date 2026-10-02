import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Settings } from "./Settings.ts";
import type { WaitingRoom } from "./WaitingRoom.ts";

/**
 * Dashboard UI providers for Cloudflare Waiting Room resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no SDK code reaches the dashboard bundle.
 */
export const WaitingRoomUI = UIProvider.succeed<WaitingRoom>(
  "Cloudflare.WaitingRoom.WaitingRoom",
  {
    displayName: "Waiting Room",
    icon: "hourglass",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.host,
    link: (ctx) =>
      ctx.attrs?.host === undefined
        ? undefined
        : `https://${ctx.attrs.host}${ctx.attrs.path ?? ""}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.waitingRoomId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "host",
        value: ctx.attrs?.host,
        href:
          ctx.attrs?.host === undefined
            ? undefined
            : `https://${ctx.attrs.host}`,
      },
      { label: "path", value: ctx.attrs?.path },
      { label: "active users", value: ctx.attrs?.totalActiveUsers },
      { label: "new users/min", value: ctx.attrs?.newUsersPerMinute },
      { label: "queueing", value: ctx.attrs?.queueingMethod },
      { label: "suspended", value: ctx.attrs?.suspended },
    ],
  },
);

export const SettingsUI = UIProvider.succeed<Settings>(
  "Cloudflare.WaitingRoom.Settings",
  {
    displayName: "Waiting Room Settings",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.zoneId ?? ctx.props?.zoneId,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "crawler bypass", value: ctx.attrs?.searchEngineCrawlerBypass },
      {
        label: "initial crawler bypass",
        value: ctx.attrs?.initialSearchEngineCrawlerBypass,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(WaitingRoomUI, SettingsUI);
