import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";

export const resources = [Account, PrivateEndpointConnection];
export const layers = () =>
  Layer.mergeAll(AccountProvider(), PrivateEndpointConnectionProvider());
