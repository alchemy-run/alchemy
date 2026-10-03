import * as Layer from "effect/Layer";
import {
  ConnectionMonitorTest,
  ConnectionMonitorTestProvider,
} from "./ConnectionMonitorTest.ts";
import { PeerAsn, PeerAsnProvider } from "./PeerAsn.ts";
import { Peering, PeeringProvider } from "./Peering.ts";
import { PeeringService, PeeringServiceProvider } from "./PeeringService.ts";
import {
  PeeringServicePrefix,
  PeeringServicePrefixProvider,
} from "./PeeringServicePrefix.ts";
import { RegisteredAsn, RegisteredAsnProvider } from "./RegisteredAsn.ts";
import {
  RegisteredPrefix,
  RegisteredPrefixProvider,
} from "./RegisteredPrefix.ts";

export const resources = [
  ConnectionMonitorTest,
  PeerAsn,
  Peering,
  PeeringService,
  PeeringServicePrefix,
  RegisteredAsn,
  RegisteredPrefix,
];
export const layers = () =>
  Layer.mergeAll(
    ConnectionMonitorTestProvider(),
    PeerAsnProvider(),
    PeeringProvider(),
    PeeringServiceProvider(),
    PeeringServicePrefixProvider(),
    RegisteredAsnProvider(),
    RegisteredPrefixProvider(),
  );
