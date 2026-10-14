import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountApiToken } from "./AccountApiToken.ts";
import type { UserApiToken } from "./UserApiToken.ts";

/**
 * Dashboard UI providers for Cloudflare ApiToken resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const UserApiTokenUI = UIProvider.succeed<UserApiToken>(
  "Cloudflare.ApiToken.UserApiToken",
  {
    displayName: "User API Token",
    icon: "key-round",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    consoleUrl: () => "https://dash.cloudflare.com/profile/api-tokens",
    facts: (ctx) => [
      { label: "token id", value: ctx.attrs?.tokenId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const AccountApiTokenUI = UIProvider.succeed<AccountApiToken>(
  "Cloudflare.ApiToken.AccountApiToken",
  {
    displayName: "Account API Token",
    icon: "key-round",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/api-tokens`,
    facts: (ctx) => [
      { label: "token id", value: ctx.attrs?.tokenId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(UserApiTokenUI, AccountApiTokenUI);
