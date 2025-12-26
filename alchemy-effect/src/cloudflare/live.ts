import * as Layer from "effect/Layer";
import * as ESBuild from "../esbuild.ts";
import { CloudflareApi } from "./api.ts";
import * as Account from "./account.ts";
import * as D1 from "./d1/index.ts";
import { databaseProvider } from "./d1/database.provider.ts";
import * as DurableObject from "./durable-object/index.ts";
import * as KV from "./kv/index.ts";
import { namespaceProvider } from "./kv/namespace.provider.ts";
import * as Queue from "./queue/index.ts";
import { queueProvider } from "./queue/queue.provider.ts";
import { bucketProvider } from "./r2/bucket.provider.ts";
import * as R2 from "./r2/index.ts";
import { assetsProvider } from "./worker/assets.provider.ts";
import { workerProvider } from "./worker/worker.provider.ts";

import "./config.ts";

export const bindings = () =>
  Layer.mergeAll(
    D1.bindFromWorker(),
    DurableObject.bindFromWorker(),
    KV.bindFromWorker(),
    Queue.bindFromWorker(),
    R2.bindFromWorker(),
  );

export const defaultProviders = () =>
  Layer.mergeAll(
    Layer.provideMerge(
      workerProvider(),
      Layer.mergeAll(ESBuild.layer(), assetsProvider()),
    ),
    databaseProvider(),
    namespaceProvider(),
    queueProvider(),
    bucketProvider(),
  ).pipe(Layer.provideMerge(bindings()));

export const providers = () =>
  defaultProviders().pipe(
    Layer.provideMerge(
      Layer.mergeAll(Account.fromStageConfig(), CloudflareApi.Default()),
    ),
  );
