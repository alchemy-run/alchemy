import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";

// SQL only?? no
// DynamoDB is faster but bounded to 400KB (<10ms minimum latency)
// S3 is slower but unbounded in size (200ms minimum latency)
// -> dual purpose for assets
// -> batching? or one file? -> Pipeline to one file. Versioned S3 Object for logs.
// -> concern with one file is size: some of our resources have like the whole fucking lambda
//    -> hash them? or etag. etag is md5
//    -> there are more large data that aren't files?
//       -> e.g. asset manifest
//       -> pointer to one file? too clever?
// -> sqlite on S3?
// SQlite on EFS. But needs a VPN.
// Roll back just from the state store??? -> needs to be fast and "build-less"
// JSON or Message Pack? I vote JSON (easy to read)

// Artifact -> stored hash only, compared on hash, not available during DELETE
// -> can't rollback just from state
// -> store it as a separate file, avoid re-writes, etc.

// SQLite in S3
// -> download, do all updates locally, upload?
// -> stream uploads
// -> not durable, but we accept that we CANT be durable
// -> it's also fast if you don't upload often

// S3 would still be fast because we sync locally

// ## Encryption
// ALCHEMY_PASSWORD suck
// ALCHEMY_STATE_TOKEN suck
// We are flattening (no more nested any state)

// in AWS this is easy - SSE (SSE + KMS)
// -> some companies would prefer CSE

// Library level encryption (SDK) -> default to no-op, favor SSE on AWS S3
// On AWS it would be KMS (we can just use IAM Role)
// On CF -> generate a Token and store in Secrets Manager?
//   -> Store it in R2 because we can't get it out?
//   -> Or build KMS on top of Workers+DO?
//   -> R2 lets us use OAuth to gain access to the encryption token

// Scrap the "key-value" store on State/Scope

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
  message: string;
  cause?: Error;
}> {}

export class State extends ServiceMap.Service<State, StateService>()(
  "AWS::Lambda::State",
) {}

export interface StateService {
  listStacks(): Effect.Effect<string[], StateStoreError, never>;
  listStages(stack: string): Effect.Effect<string[], StateStoreError, never>;
  // stub
  get(request: {
    stack: string;
    stage: string;
    logicalId: string;
  }): Effect.Effect<ResourceState | undefined, StateStoreError, never>;
  getReplacedResources(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<ReplacedResourceState[], StateStoreError, never>;
  set<V extends ResourceState>(request: {
    stack: string;
    stage: string;
    logicalId: string;
    value: V;
  }): Effect.Effect<V, StateStoreError, never>;
  delete(request: {
    stack: string;
    stage: string;
    logicalId: string;
  }): Effect.Effect<void, StateStoreError, never>;
  list(request: {
    stack: string;
    stage: string;
  }): Effect.Effect<string[], StateStoreError, never>;
}
