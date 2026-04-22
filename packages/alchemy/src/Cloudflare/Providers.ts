import * as Layer from "effect/Layer";
import { Command } from "../Build/Command.ts";
import * as Build from "../Build/index.ts";
import * as Provider from "../Provider.ts";
import { Random, RandomProvider } from "../Random.ts";
import { CloudflareAuth } from "./Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "./CloudflareEnvironment.ts";
import * as Containers from "./Container/index.ts";
import * as Credentials from "./Credentials.ts";
import * as D1 from "./D1/index.ts";
import * as KV from "./KV/index.ts";
import * as R2 from "./R2/index.ts";
import * as Queue from "./Queue/index.ts";
import * as Workers from "./Workers/index.ts";
import * as Workflows from "./Workers/Workflow.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Cloudflare",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Cloudflare providers, bindings, and credentials for Worker-based stacks.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Command,
      Containers.Container,
      D1.D1ConnectionPolicy,
      D1.D1Database,
      KV.KVNamespace,
      KV.KVNamespaceBindingPolicy,
      Queue.Queue,
      Queue.QueueBindingPolicy,
      Queue.QueueConsumer,
      R2.R2Bucket,
      R2.R2BucketBindingPolicy,
      Random,
      Workers.BindWorkerPolicy,
      Workers.FetchPolicy,
      Workers.Worker,
      Workflows.WorkflowResource,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Containers.ContainerProvider(),
        D1.D1ConnectionPolicyLive,
        D1.DatabaseProvider(),
        KV.KVNamespaceBindingPolicyLive,
        KV.KVNamespaceProvider(),
        Queue.QueueBindingPolicyLive,
        Queue.QueueProvider(),
        Queue.QueueConsumerProvider(),
        R2.R2BucketBindingPolicyLive,
        R2.R2BucketProvider(),
        Workers.BindWorkerPolicyLive,
        Workers.FetchPolicyLive,
        Workers.WorkerProvider(),
        Workflows.WorkflowProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(Build.CommandProvider(), RandomProvider()),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.orDie,
  );
