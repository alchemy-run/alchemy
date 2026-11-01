import {
  OpenSearchCredentials,
  opensearchBulkBody,
  opensearchCredentialsOf,
} from "@distilled.cloud/stackit/OpenSearch";
import * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import type { BulkRequest } from "./Bulk.ts";
import type { Credential } from "./Credential.ts";
import type { IndexDocumentRequest } from "./IndexDocument.ts";
import type { Instance } from "./Instance.ts";
import { toRedacted } from "./internal.ts";
import type { ReadIndexClient } from "./ReadIndex.ts";
import type { ReadWriteIndexClient } from "./ReadWriteIndex.ts";
import type { WriteIndexClient } from "./WriteIndex.ts";

/**
 * Shared HTTP scaffolding for STACKIT OpenSearch bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the instance: STACKIT has no role binding on a
 * single instance (see `StackitBindings`). The grants list exactly the permissions
 * an operation needs. The names are the `x-stackit-authorization` actions in the
 * service's API spec.
 */

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.OpenSearch.GetInstance`. */
  tag: string;
  /** The permission the operation needs on the project holding the instance. */
  permission: string;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/**
 * Where a host reads a credential's connection details, once its bundle runs. A
 * value can reach the host unwrapped, whatever its type says.
 */
export interface OpenSearchAccess {
  readonly uri: Effect.Effect<string | Redacted.Redacted<string>>;
  readonly username: Effect.Effect<string>;
  readonly password: Effect.Effect<string | Redacted.Redacted<string>>;
}

/** Calls `opensearch_data` operations with a bound credential's user and password. */
export interface OpenSearchCaller {
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, data.OpenSearchOpContext>,
    request: I,
  ): Effect.Effect<A, E>;
}

/**
 * The caller for one credential. Each request acquires what it needs, so nothing
 * outlives a request on a host like workerd.
 *
 * These bindings authenticate with the credential, so they grant no STACKIT role and
 * create no service account: its attributes travel through the host's environment,
 * with the password and URI kept `Redacted`.
 */
export const makeOpenSearchCaller =
  (access: OpenSearchAccess): OpenSearchCaller =>
  (operation, request) =>
    Effect.gen(function* () {
      const uri = yield* access.uri;
      const username = yield* access.username;
      const password = yield* access.password;
      return yield* operation(request).pipe(
        Effect.provideService(
          OpenSearchCredentials,
          opensearchCredentialsOf({
            uri: Redacted.isRedacted(uri) ? Redacted.value(uri) : uri,
            username,
            password: toRedacted(password),
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      );
    });

/** Resolve a credential's connection details once, when the binding is built. */
const accessOf = Effect.fn(function* (credential: Credential) {
  const uri = yield* credential.uri;
  const username = yield* credential.username;
  const password = yield* credential.password;
  return { uri, username, password } satisfies OpenSearchAccess;
});

/** Build a binding over a client of the REST API: `<Op>Http.ts` is one call to it. */
export const makeIndexBinding = <Client>(makeClient: (call: OpenSearchCaller) => Client) =>
  Effect.fn(function* (credential: Credential) {
    const access = yield* accessOf(credential);
    return makeClient(makeOpenSearchCaller(access));
  });

/** Index a document under `id`, or under one OpenSearch generates without it. */
export const indexDocument = (call: OpenSearchCaller, request: IndexDocumentRequest) =>
  "id" in request && request.id !== undefined
    ? call(data.indexDocument, request as data.IndexDocumentRequest)
    : call(data.addDocument, request as data.AddDocumentRequest);

/** Write `lines` as `_bulk`'s newline-delimited body and send it. */
export const bulk = (call: OpenSearchCaller, request: BulkRequest) => {
  const { lines, ...rest } = request;
  return call(data.bulk, { ...rest, body: opensearchBulkBody(lines) });
};

/** Build the read client for a credential. */
export const makeReadIndexClient = (call: OpenSearchCaller): ReadIndexClient => ({
  search: (request) => call(data.search, request),
  get: (request) => call(data.getDocument, request),
});

/** Build the write client for a credential. */
export const makeWriteIndexClient = (call: OpenSearchCaller): WriteIndexClient => ({
  index: (request) => indexDocument(call, request),
  delete: (request) => call(data.deleteDocument, request),
  bulk: (request) => bulk(call, request),
});

/** Build the client with every read and write operation. */
export const makeReadWriteIndexClient = (call: OpenSearchCaller): ReadWriteIndexClient => ({
  ...makeReadIndexClient(call),
  ...makeWriteIndexClient(call),
});
