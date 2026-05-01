import { makeCreateStore } from "@/Cloudflare/SecretsStore/SecretsStore";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * Test harness that captures the outbound `HttpClientRequest` and lets the
 * caller plug in a canned `Response`. The previous bug — Cloudflare's
 * `secrets_store/stores` POST receiving an array body and rejecting it as
 * `invalid_json_body` — is invisible to the type system because the
 * upstream SDK schema models the body as `{ name }[]`. The only way to
 * regression-test it is to inspect the actual bytes we put on the wire.
 */
interface Captured {
  url: string;
  method: string;
  contentType: string | undefined;
  bodyText: string;
  bodyJson: unknown;
  authorization: string | undefined;
}

const harness = (response: Response) => {
  let captured: Captured | undefined;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body as HttpBody.HttpBody;
      let bodyText = "";
      if (body._tag === "Uint8Array") {
        bodyText = new TextDecoder().decode(body.body);
      }
      captured = {
        url: request.url,
        method: request.method,
        contentType:
          body._tag === "Uint8Array" ? body.contentType : undefined,
        bodyText,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
        authorization: request.headers.authorization,
      };
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
  );
  return { layer, get: () => captured };
};

const successResponse = () =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        id: "store-id-123",
        name: "default_secrets_store",
        created: "2026-01-01T00:00:00Z",
        modified: "2026-01-01T00:00:00Z",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const errorResponse = (
  status: number,
  errors: Array<{ code: number; message: string }>,
) =>
  new Response(
    JSON.stringify({ success: false, errors, messages: [], result: null }),
    { status, headers: { "content-type": "application/json" } },
  );

it.live(
  "createStore POSTs a single JSON object body (regression: invalid_json_body)",
  () =>
    Effect.gen(function* () {
      const { layer, get } = harness(successResponse());

      const result = yield* Effect.gen(function* () {
        const create = yield* makeCreateStore;
        return yield* create({
          accountId: "acct-abc",
          name: "default_secrets_store",
        });
      }).pipe(Effect.provide(layer));

      expect(result.result).toEqual({
        id: "store-id-123",
        name: "default_secrets_store",
        created: "2026-01-01T00:00:00Z",
        modified: "2026-01-01T00:00:00Z",
      });

      const sent = get();
      expect(sent).toBeDefined();
      expect(sent!.method).toBe("POST");
      expect(sent!.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-abc/secrets_store/stores",
      );
      expect(sent!.contentType).toMatch(/application\/json/);
      expect(sent!.authorization).toBe("Bearer test-token");

      // The whole point of this test: the body must be a single
      // object, not an array. Cloudflare's REST API expects
      // `{"name": "..."}` and rejects `[{"name": "..."}]` with
      // code 1001 `invalid_json_body`.
      expect(sent!.bodyJson).toEqual({ name: "default_secrets_store" });
      expect(Array.isArray(sent!.bodyJson)).toBe(false);
    }),
);

it.live("createStore percent-encodes the accountId path segment", () =>
  Effect.gen(function* () {
    const { layer, get } = harness(successResponse());

    yield* Effect.gen(function* () {
      const create = yield* makeCreateStore;
      return yield* create({
        accountId: "acct/with spaces",
        name: "store",
      });
    }).pipe(Effect.provide(layer));

    expect(get()!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct%2Fwith%20spaces/secrets_store/stores",
    );
  }),
);

it.live(
  "createStore surfaces MaximumStoresExceeded as the SDK's tagged error so callers can catchTag it",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(
        errorResponse(409, [
          { code: 1003, message: "maximum_stores_exceeded" },
        ]),
      );

      const result = yield* Effect.gen(function* () {
        const create = yield* makeCreateStore;
        return yield* create({ accountId: "acct-abc", name: "x" }).pipe(
          Effect.catchTag(
            "MaximumStoresExceeded",
            (e) => Effect.succeed(e),
          ),
        );
      }).pipe(Effect.provide(layer));

      expect(result).toBeInstanceOf(secretsStore.MaximumStoresExceeded);
      const err = result as secretsStore.MaximumStoresExceeded;
      expect(err._tag).toBe("MaximumStoresExceeded");
      expect(err.message).toBe("maximum_stores_exceeded");
    }),
);
