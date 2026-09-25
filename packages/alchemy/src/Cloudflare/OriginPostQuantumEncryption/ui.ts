import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { OriginPostQuantumEncryption } from "./OriginPostQuantumEncryption.ts";

/**
 * Dashboard UI providers for Cloudflare Origin Post-Quantum Encryption
 * resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const OriginPostQuantumEncryptionUI =
  UIProvider.succeed<OriginPostQuantumEncryption>(
    "Cloudflare.OriginPostQuantumEncryption.OriginPostQuantumEncryption",
    {
      displayName: "Origin Post-Quantum Encryption",
      icon: "atom",
      color: "#F6821F",
      category: "security",
      summary: (ctx) => ctx.attrs?.value,
      facts: (ctx) => [
        { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
        { label: "value", value: ctx.attrs?.value },
        { label: "editable", value: ctx.attrs?.editable },
        { label: "initial value", value: ctx.attrs?.initialValue },
        { label: "modified", value: ctx.attrs?.modifiedOn },
      ],
    },
  );

export const ui = () => Layer.mergeAll(OriginPostQuantumEncryptionUI);
