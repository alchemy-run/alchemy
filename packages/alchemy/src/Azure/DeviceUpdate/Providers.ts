import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { Instance, InstanceProvider } from "./Instance.ts";

export const resources = [Account, Instance];
export const layers = () =>
  Layer.mergeAll(AccountProvider(), InstanceProvider());
