import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Server } from "./Server.ts";
import type { User } from "./User.ts";

/**
 * Dashboard UI providers for AWS Transfer resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const ServerUI = UIProvider.succeed<Server>("AWS.Transfer.Server", {
  displayName: "Transfer Family Server",
  icon: "server",
  color: "#7AA116",
  category: "storage",
  summary: (ctx) => ctx.attrs?.serverId,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.arn);
    return ctx.attrs?.serverId === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/transfer/home?region=${region}#/servers/${ctx.attrs.serverId}`;
  },
  facts: (ctx) => [
    { label: "server", value: ctx.attrs?.serverId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    { label: "endpoint type", value: ctx.attrs?.endpointType },
    { label: "domain", value: ctx.attrs?.domain },
    { label: "identity provider", value: ctx.attrs?.identityProviderType },
    { label: "protocols", value: ctx.attrs?.protocols?.join(", ") },
    { label: "state", value: ctx.attrs?.state },
  ],
});

export const UserUI = UIProvider.succeed<User>("AWS.Transfer.User", {
  displayName: "Transfer Family User",
  icon: "user",
  color: "#7AA116",
  category: "auth",
  summary: (ctx) => ctx.attrs?.userName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.arn);
    return ctx.attrs?.serverId === undefined ||
      ctx.attrs?.userName === undefined ||
      region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/transfer/home?region=${region}#/servers/${ctx.attrs.serverId}/users/${ctx.attrs.userName}`;
  },
  facts: (ctx) => [
    { label: "user", value: ctx.attrs?.userName, copy: true },
    { label: "server", value: ctx.attrs?.serverId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    { label: "role", value: ctx.attrs?.role, mono: true },
    { label: "home directory", value: ctx.attrs?.homeDirectory, mono: true },
  ],
});

export const ui = () => Layer.mergeAll(ServerUI, UserUI);
