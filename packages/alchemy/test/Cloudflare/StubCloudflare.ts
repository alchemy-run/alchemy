import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthConfig.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { InstanceId } from "@/InstanceId.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export const ACCOUNT_ID = "test-account";

export interface StubCall {
  method: string;
  /** Path below `/client/v4`, e.g. `/accounts/test-account/access/apps`. */
  path: string;
  query: URLSearchParams;
  body: any;
}

/**
 * Offline Cloudflare API for driving a real provider: records every request
 * and answers with the envelope `result` returned by `respond` (or a raw
 * `Response` for errors).
 */
export const stubCloudflare = (respond: (call: StubCall) => unknown) => {
  const calls: StubCall[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body as HttpBody.HttpBody;
      const text =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const url = new URL(request.url);
      const call: StubCall = {
        method: request.method,
        path: url.pathname.replace("/client/v4", ""),
        query: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
      };
      calls.push(call);
      const result = respond(call);
      return HttpClientResponse.fromWeb(
        request,
        result instanceof Response
          ? result
          : Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("test-token"),
        accountId: ACCOUNT_ID,
        source: { type: "env" },
      } satisfies CloudflareResolvedCredentials),
    ),
    Layer.succeed(Stack, {
      name: "stub-stack",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, "test"),
    Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
  );
  return { calls, layer };
};

export const notFound = (code: number, message: string) =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status: 404 },
  );

export const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};
