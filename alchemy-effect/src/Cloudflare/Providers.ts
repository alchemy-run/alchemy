import * as Auth from "@distilled.cloud/cloudflare/Auth";
import { BundleLive } from "@distilled.cloud/cloudflare-bundler";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BuildProvider } from "../Build/Build.ts";
import { esbuild } from "../Bundle/ESBuild.ts";
import type { Provider } from "../Provider.ts";
import * as Account from "./Account.ts";
import * as KV from "./KV/index.ts";
import * as R2 from "./R2/index.ts";
import { AssetsProvider } from "./Workers/Assets.ts";
import * as Workers from "./Workers/index.ts";
import { WorkerProvider } from "./Workers/Worker.ts";

export type Providers = Extract<
  Layer.Success<ReturnType<typeof providers>>,
  Provider<any>
>;

export const providers = () =>
  pipe(
    resources(),
    Layer.provideMerge(bindings()),
    Layer.provideMerge(utils()),
    Layer.provideMerge(credentials()),
    Layer.orDie,
  );

export const credentials = () =>
  Layer.mergeAll(
    Account.fromStageConfig(),
    Layer.provideMerge(Auth.fromEnv(), FetchHttpClient.layer),
  );

export const resources = () =>
  Layer.mergeAll(
    BuildProvider(),
    WorkerProvider(),
    KV.NamespaceProvider(),
    R2.BucketProvider(),
  );

export const bindings = () =>
  Layer.mergeAll(
    R2.GetObjectPolicyLive,
    R2.PutObjectPolicyLive,
    R2.DeleteObjectPolicyLive,
    R2.HeadObjectPolicyLive,
    R2.ListObjectsPolicyLive,
    R2.CreateMultipartUploadPolicyLive,
    R2.ResumeMultipartUploadPolicyLive,
    KV.GetPolicyLive,
    KV.PutPolicyLive,
    KV.DeletePolicyLive,
    KV.ListPolicyLive,
    KV.GetWithMetadataPolicyLive,
    Workers.DurableObjectPolicyLive,
  );

const utils = () => Layer.mergeAll(BundleLive, esbuild(), AssetsProvider());
