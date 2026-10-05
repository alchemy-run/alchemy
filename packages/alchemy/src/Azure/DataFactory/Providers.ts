import * as Layer from "effect/Layer";
import {
  ChangeDataCapture,
  ChangeDataCaptureProvider,
} from "./ChangeDataCapture.ts";
import { Credential, CredentialProvider } from "./Credential.ts";
import { DataFlow, DataFlowProvider } from "./DataFlow.ts";
import { Dataset, DatasetProvider } from "./Dataset.ts";
import { Factory, FactoryProvider } from "./Factory.ts";
import { GlobalParameter, GlobalParameterProvider } from "./GlobalParameter.ts";
import {
  IntegrationRuntime,
  IntegrationRuntimeProvider,
} from "./IntegrationRuntime.ts";
import { LinkedService, LinkedServiceProvider } from "./LinkedService.ts";
import {
  ManagedPrivateEndpoint,
  ManagedPrivateEndpointProvider,
} from "./ManagedPrivateEndpoint.ts";
import {
  ManagedVirtualNetwork,
  ManagedVirtualNetworkProvider,
} from "./ManagedVirtualNetwork.ts";
import { Pipeline, PipelineProvider } from "./Pipeline.ts";
import { Trigger, TriggerProvider } from "./Trigger.ts";

export const resources = [
  ChangeDataCapture,
  Credential,
  DataFlow,
  Dataset,
  Factory,
  GlobalParameter,
  IntegrationRuntime,
  LinkedService,
  ManagedPrivateEndpoint,
  ManagedVirtualNetwork,
  Pipeline,
  Trigger,
];
export const layers = () =>
  Layer.mergeAll(
    ChangeDataCaptureProvider(),
    CredentialProvider(),
    DataFlowProvider(),
    DatasetProvider(),
    FactoryProvider(),
    GlobalParameterProvider(),
    IntegrationRuntimeProvider(),
    LinkedServiceProvider(),
    ManagedPrivateEndpointProvider(),
    ManagedVirtualNetworkProvider(),
    PipelineProvider(),
    TriggerProvider(),
  );
