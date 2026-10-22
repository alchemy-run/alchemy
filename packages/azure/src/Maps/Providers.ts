import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";

export const resources = [Account];
export const layers = () => Layer.mergeAll(AccountProvider());
