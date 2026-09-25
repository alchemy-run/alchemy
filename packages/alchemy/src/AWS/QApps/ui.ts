import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { QApp } from "./QApp.ts";

/**
 * Dashboard UI providers for AWS QApps resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const QAppUI = UIProvider.succeed<QApp>("AWS.QApps.QApp", {
  displayName: "Q App",
  icon: "sparkles",
  color: "#01A88D",
  category: "ai",
  summary: (ctx) => ctx.attrs?.title,
  facts: (ctx) => [
    { label: "title", value: ctx.attrs?.title, copy: true },
    { label: "id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.appArn, mono: true, copy: true },
    { label: "instance", value: ctx.attrs?.instanceId, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "version", value: ctx.attrs?.appVersion },
  ],
});

export const ui = () => Layer.mergeAll(QAppUI);
