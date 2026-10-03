import * as Layer from "effect/Layer";
import { AlertSetting, AlertSettingProvider } from "./AlertSetting.ts";
import { Policy, PolicyProvider } from "./Policy.ts";
import { Vault, VaultProvider } from "./Vault.ts";

export const resources = [AlertSetting, Policy, Vault];
export const layers = () =>
  Layer.mergeAll(AlertSettingProvider(), PolicyProvider(), VaultProvider());
