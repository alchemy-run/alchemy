import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AdminAccount } from "./AdminAccount.ts";

/**
 * Dashboard UI providers for AWS FMS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AdminAccountUI = UIProvider.succeed<AdminAccount>(
  "AWS.FMS.AdminAccount",
  {
    displayName: "Firewall Manager Admin Account",
    icon: "shield",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.adminAccount,
    facts: (ctx) => [
      {
        label: "account",
        value: ctx.attrs?.adminAccount,
        mono: true,
        copy: true,
      },
      { label: "role status", value: ctx.attrs?.roleStatus },
    ],
  },
);

export const ui = () => Layer.mergeAll(AdminAccountUI);
