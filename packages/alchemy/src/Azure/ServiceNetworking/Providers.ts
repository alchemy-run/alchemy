import * as Layer from "effect/Layer";
import { Association, AssociationProvider } from "./Association.ts";
import { Frontend, FrontendProvider } from "./Frontend.ts";
import { SecurityPolicy, SecurityPolicyProvider } from "./SecurityPolicy.ts";
import {
  TrafficController,
  TrafficControllerProvider,
} from "./TrafficController.ts";

export const resources = [
  Association,
  Frontend,
  SecurityPolicy,
  TrafficController,
];
export const layers = () =>
  Layer.mergeAll(
    AssociationProvider(),
    FrontendProvider(),
    SecurityPolicyProvider(),
    TrafficControllerProvider(),
  );
