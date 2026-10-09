import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LiveInput } from "./LiveInput.ts";
import type { LiveInputOutput } from "./LiveInputOutput.ts";
import type { SigningKey } from "./SigningKey.ts";
import type { Watermark } from "./Watermark.ts";
import type { Webhook } from "./Webhook.ts";

/**
 * Dashboard UI providers for Cloudflare Stream resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const LiveInputUI = UIProvider.succeed<LiveInput>(
  "Cloudflare.Stream.LiveInput",
  {
    displayName: "Stream Live Input",
    icon: "radio",
    color: "#F6821F",
    category: "media",
    summary: (ctx) =>
      (ctx.attrs?.meta?.name as string | undefined) ?? ctx.attrs?.liveInputId,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined || ctx.attrs.liveInputId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/stream/inputs/${ctx.attrs.liveInputId}`,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.liveInputId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.meta?.name as string | undefined },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "recording", value: ctx.props?.recording?.mode },
      {
        label: "delete recordings after",
        value:
          ctx.attrs?.deleteRecordingAfterDays === undefined
            ? undefined
            : `${ctx.attrs.deleteRecordingAfterDays} days`,
      },
      { label: "created", value: ctx.attrs?.created },
    ],
  },
);

export const LiveInputOutputUI = UIProvider.succeed<LiveInputOutput>(
  "Cloudflare.Stream.LiveInputOutput",
  {
    displayName: "Stream Live Output",
    icon: "cast",
    color: "#F6821F",
    category: "media",
    summary: (ctx) => ctx.attrs?.url ?? ctx.attrs?.outputId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.outputId, mono: true, copy: true },
      {
        label: "live input",
        value: ctx.attrs?.liveInputId,
        mono: true,
        copy: true,
      },
      { label: "url", value: ctx.attrs?.url, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const SigningKeyUI = UIProvider.succeed<SigningKey>(
  "Cloudflare.Stream.SigningKey",
  {
    displayName: "Stream Signing Key",
    icon: "key-round",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.keyId,
    facts: (ctx) => [
      { label: "key id", value: ctx.attrs?.keyId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "created", value: ctx.attrs?.created },
    ],
  },
);

export const WatermarkUI = UIProvider.succeed<Watermark>(
  "Cloudflare.Stream.Watermark",
  {
    displayName: "Stream Watermark",
    icon: "stamp",
    color: "#F6821F",
    category: "media",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.watermarkId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.watermarkId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "position", value: ctx.attrs?.position },
      { label: "opacity", value: ctx.attrs?.opacity },
      { label: "scale", value: ctx.attrs?.scale },
      {
        label: "dimensions",
        value:
          ctx.attrs?.width === undefined || ctx.attrs?.height === undefined
            ? undefined
            : `${ctx.attrs.width}x${ctx.attrs.height}`,
      },
      { label: "created", value: ctx.attrs?.created },
    ],
  },
);

export const WebhookUI = UIProvider.succeed<Webhook>(
  "Cloudflare.Stream.Webhook",
  {
    displayName: "Stream Webhook",
    icon: "webhook",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.notificationUrl,
    facts: (ctx) => [
      {
        label: "notification url",
        value: ctx.attrs?.notificationUrl,
        href: ctx.attrs?.notificationUrl,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "modified", value: ctx.attrs?.modified },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    LiveInputUI,
    LiveInputOutputUI,
    SigningKeyUI,
    WatermarkUI,
    WebhookUI,
  );
