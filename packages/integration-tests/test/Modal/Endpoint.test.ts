import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as endpoint from "@distilled.cloud/modal/endpoint";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Modal.providers() });

// Serves a catalog model on Modal's shared capacity, billed per token.
test.provider.skipIf(!!process.env.FAST)(
  "serve a catalog model behind the OpenAI API and stop it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Modal creates an authenticated endpoint only once a webhook token
      // with access to its environment exists.
      yield* stack.deploy(Modal.WebhookToken("EndpointCaller", {}));
      const { qwen, caller } = yield* stack.deploy(
        Effect.gen(function* () {
          const qwen = yield* Modal.Endpoint("Qwen", {
            model: { repoId: "zai-org/GLM-5.3-Flash" },
            servingMode: "shared",
          });
          const caller = yield* Modal.WebhookToken("EndpointCaller", {});
          return { qwen, caller };
        }),
      );
      expect(qwen.url).toMatch(/^https:\/\//);

      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${qwen.url}/v1/chat/completions`).pipe(
          HttpClientRequest.setHeaders({
            "Modal-Key": caller.tokenId,
            "Modal-Secret": Redacted.value(caller.tokenSecret),
          }),
          HttpClientRequest.bodyJsonUnsafe({
            model: "zai-org/GLM-5.3-Flash",
            messages: [{ role: "user", content: "Say ok." }],
            max_tokens: 8,
          }),
        ),
      );
      expect(response.status).toBe(200);

      yield* stack.destroy();
      const info = yield* endpoint.endpointGetInfo({ endpointId: qwen.endpointId });
      expect(info.info?.lifecycle?.status).toBe("ENDPOINT_LIFECYCLE_STATUS_STOPPED");
    }),
  { tags: ["provider:modal", "provider:modal:endpoint", "live", "slow"], timeout: 2_400_000 },
);
