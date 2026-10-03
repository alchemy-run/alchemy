import * as Layer from "effect/Layer";
import {
  AkriConnectorTemplate,
  AkriConnectorTemplateProvider,
} from "./AkriConnectorTemplate.ts";
import { Broker, BrokerProvider } from "./Broker.ts";
import {
  BrokerAuthentication,
  BrokerAuthenticationProvider,
} from "./BrokerAuthentication.ts";
import {
  BrokerAuthorization,
  BrokerAuthorizationProvider,
} from "./BrokerAuthorization.ts";
import { BrokerListener, BrokerListenerProvider } from "./BrokerListener.ts";
import { Dataflow, DataflowProvider } from "./Dataflow.ts";
import {
  DataflowEndpoint,
  DataflowEndpointProvider,
} from "./DataflowEndpoint.ts";
import { DataflowGraph, DataflowGraphProvider } from "./DataflowGraph.ts";
import { DataflowProfile, DataflowProfileProvider } from "./DataflowProfile.ts";
import { Instance, InstanceProvider } from "./Instance.ts";
import {
  RegistryEndpoint,
  RegistryEndpointProvider,
} from "./RegistryEndpoint.ts";

export const resources = [
  AkriConnectorTemplate,
  Broker,
  BrokerAuthentication,
  BrokerAuthorization,
  BrokerListener,
  Dataflow,
  DataflowEndpoint,
  DataflowGraph,
  DataflowProfile,
  Instance,
  RegistryEndpoint,
];
export const layers = () =>
  Layer.mergeAll(
    AkriConnectorTemplateProvider(),
    BrokerProvider(),
    BrokerAuthenticationProvider(),
    BrokerAuthorizationProvider(),
    BrokerListenerProvider(),
    DataflowProvider(),
    DataflowEndpointProvider(),
    DataflowGraphProvider(),
    DataflowProfileProvider(),
    InstanceProvider(),
    RegistryEndpointProvider(),
  );
