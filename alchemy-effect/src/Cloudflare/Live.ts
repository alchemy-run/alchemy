import * as Auth from "distilled-cloudflare/Auth";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as ESBuild from "../Bundle/ESBuild.ts";
import * as Account from "./Account.ts";
import { CloudflareApiDefault } from "./CloudflareApi.ts";
import * as KV from "./KV/index.ts";
import * as R2 from "./R2/index.ts";
import { AssetsProvider } from "./Workers/Assets.ts";
import { WorkerProvider } from "./Workers/Worker.ts";

import "./StageConfig.ts";

export const r2BindingsLive = () =>
  Layer.mergeAll(
    R2.GetObjectLive,
    R2.GetObjectPolicyLive,
    R2.PutObjectLive,
    R2.PutObjectPolicyLive,
    R2.DeleteObjectLive,
    R2.DeleteObjectPolicyLive,
    R2.HeadObjectLive,
    R2.HeadObjectPolicyLive,
    R2.ListObjectsLive,
    R2.ListObjectsPolicyLive,
    R2.CreateMultipartUploadLive,
    R2.CreateMultipartUploadPolicyLive,
    R2.ResumeMultipartUploadLive,
    R2.ResumeMultipartUploadPolicyLive,
  );

export const kvBindingsLive = () =>
  Layer.mergeAll(
    KV.GetLive,
    KV.GetPolicyLive,
    KV.PutLive,
    KV.PutPolicyLive,
    KV.DeleteLive,
    KV.DeletePolicyLive,
    KV.ListLive,
    KV.ListPolicyLive,
    KV.GetWithMetadataLive,
    KV.GetWithMetadataPolicyLive,
  );

export const bindingsLive = () =>
  Layer.mergeAll(r2BindingsLive(), kvBindingsLive());

export const resourceProviders = () =>
  Layer.mergeAll(
    Layer.provideMerge(
      WorkerProvider(),
      Layer.mergeAll(ESBuild.ESBuildLive(), AssetsProvider()),
    ),
    KV.NamespaceProvider(),
    R2.BucketProvider(),
  );

export const distilledCloudflareAuth = () =>
  Layer.provideMerge(Auth.fromEnv(), FetchHttpClient.layer);

export const defaultProviders = () =>
  resourceProviders().pipe(Layer.provideMerge(distilledCloudflareAuth()));

export default defaultProviders().pipe(
  Layer.provideMerge(
    Layer.mergeAll(Account.fromStageConfig(), CloudflareApiDefault()),
  ),
);
