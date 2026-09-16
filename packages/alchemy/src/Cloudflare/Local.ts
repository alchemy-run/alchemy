/**
 * The Cloudflare provider group served by the dev sidecar (see
 * `Local/Sidecar.ts`): the workerd-backed local providers, built per
 * session the first time a stack asks for one of their types.
 */
import { AppProviderLocal } from "./Flagship/App.ts";
import { FlagProviderLocal } from "./Flagship/Flag.ts";
import {
  StreamProviderLocal,
  SinkProviderLocal,
  PipelineProviderLocal,
} from "./Pipelines/Local.ts";
import * as Layer from "effect/Layer";
import { DockerLive } from "../Docker/Docker.ts";
import type * as RpcServer from "../Local/RpcServer.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import { LocalContainerProvider } from "./Containers/LocalContainerProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ProviderLocal as D1ProviderLocal } from "./D1/Database.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import { ProviderLocal } from "./Queues/Queue.ts";
import { ConsumerProviderLocal } from "./Queues/Consumer.ts";
import { SecretProviderLocal } from "./SecretsStore/Secret.ts";
import { IndexProviderLocal } from "./Vectorize/VectorizeIndex.ts";
import { MetadataIndexProviderLocal } from "./Vectorize/VectorizeMetadataIndex.ts";
import { LocalWorkerProvider } from "./Workers/LocalWorkerProvider.ts";

const cloudflareServices = Layer.provide(
  Layer.merge(
    Credentials.fromAuthProvider(),
    CloudflareEnvironment.fromProfile(),
  ),
  CloudflareAuth,
);

export default Layer.mergeAll(
  LocalWorkerProvider(),
  AppProviderLocal(),
  FlagProviderLocal(),
  StreamProviderLocal(),
  SinkProviderLocal(),
  PipelineProviderLocal(),
  LocalContainerProvider(),
  ProviderLocal(),
  ConsumerProviderLocal(),
  D1ProviderLocal(),
  SecretProviderLocal(),
  IndexProviderLocal(),
  MetadataIndexProviderLocal(),
).pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(cloudflareServices),
  Layer.provide(DockerLive),
) satisfies RpcServer.ProviderLayer;
