import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Account } from "./Account.ts";
import type { Member } from "./Member.ts";

/**
 * Dashboard UI providers for Cloudflare Account resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AccountUI = UIProvider.succeed<Account>(
  "Cloudflare.Account.Account",
  {
    displayName: "Cloudflare Account",
    icon: "building-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "parent org", value: ctx.attrs?.parentOrgName },
      { label: "2FA enforced", value: ctx.attrs?.enforceTwofactor },
      { label: "created", value: ctx.attrs?.createdOn },
    ],
  },
);

export const MemberUI = UIProvider.succeed<Member>(
  "Cloudflare.Account.Member",
  {
    displayName: "Account Member",
    icon: "user-round",
    color: "#F6821F",
    category: "auth",
    summary: (ctx) => ctx.attrs?.email,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/members`,
    facts: (ctx) => [
      { label: "email", value: ctx.attrs?.email, copy: true },
      {
        label: "member id",
        value: ctx.attrs?.memberId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "roles",
        value: ctx.attrs?.roles?.length
          ? ctx.attrs.roles.map((r) => r.name).join(", ")
          : undefined,
      },
      { label: "policies", value: ctx.attrs?.policies?.length },
    ],
  },
);

export const ui = () => Layer.mergeAll(AccountUI, MemberUI);
