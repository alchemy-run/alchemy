import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Vault } from "./Vault.ts";

/**
 * Dashboard UI providers for AWS Glacier resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const VaultUI = UIProvider.succeed<Vault>("AWS.Glacier.Vault", {
  displayName: "Glacier Vault",
  icon: "archive",
  color: "#7AA116",
  category: "storage",
  summary: (ctx) => ctx.attrs?.vaultName,
  facts: (ctx) => [
    { label: "vault", value: ctx.attrs?.vaultName, copy: true },
    { label: "arn", value: ctx.attrs?.vaultArn, mono: true, copy: true },
    { label: "created", value: ctx.attrs?.creationDate },
  ],
});

export const ui = () => Layer.mergeAll(VaultUI);
