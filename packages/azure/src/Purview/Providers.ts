import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { KafkaConfiguration, KafkaConfigurationProvider } from "./KafkaConfiguration.ts";

export const resources = [Account, KafkaConfiguration];
export const layers = () => Layer.mergeAll(AccountProvider(), KafkaConfigurationProvider());
