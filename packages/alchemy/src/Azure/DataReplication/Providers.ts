import * as Layer from "effect/Layer";
import { Vault, VaultProvider } from "./Vault.ts";

export const resources = [Vault];
export const layers = () => Layer.mergeAll(VaultProvider());
