import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment, stackitTags } from "../helpers.ts";
import { CHEAP_CHAT_MODEL, CHEAP_EMBEDDING_MODEL } from "./fixtures/models.ts";
import ModelServingBindingsWorker, { Inference } from "./fixtures/worker.ts";
import { observeToken } from "./modelServing.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitModelServingBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ModelServingBindingsWorker;
    const token = yield* Inference;
    return {
      url: worker.url.as<string>(),
      tokenId: token.tokenId,
      name: token.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const OPTIONS = {
  tags: [...stackitTags("modelserving", "bindings"), "provider:cloudflare"],
  timeout: 180_000,
} as const;

// A token costs nothing, and the prompts here cost under EUR 0.01 a run (see `modelServing.ts`).
describe.sequential(
  "STACKIT AI Model Serving bindings on a Cloudflare Worker",
  { tags: [...stackitTags("modelserving", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real failure
    // shows its error. Each retry of an inference route costs a few tokens.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** The model the catalogue lists under `name`, in the profile's region. */
    const catalogueModel = (name: string) =>
      Effect.gen(function* () {
        const { region } = yield* stackitEnvironment;
        const { models } = yield* modelServing.listModels({ regionId: region });
        const model = models.find((item) => item.name === name);
        expect(model?.name).toEqual(name);
        return { region, modelId: model!.id };
      });

    describe("GetToken", () => {
      test.provider(
        "reads the bound token, without its value",
        (_stack) =>
          Effect.gen(function* () {
            const { tokenId } = yield* stack;
            const body = yield* call("/get-token");
            expectOk(body);
            expect(body.result.token.id).toEqual(tokenId);
            expect(body.result.token.state).toEqual("active");
            expect(body.result.token.content).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("ListTokens", () => {
      test.provider(
        "lists the bound token",
        (_stack) =>
          Effect.gen(function* () {
            const { tokenId } = yield* stack;
            const body = yield* call("/list-tokens");
            expectOk(body);
            expect(body.result.tokens.map((item: { id: string }) => item.id)).toContain(tokenId);
          }),
        OPTIONS,
      );
    });

    describe("ListModels", () => {
      test.provider(
        "lists a chat model of the region",
        (_stack) =>
          Effect.gen(function* () {
            const { region } = yield* stackitEnvironment;
            const body = yield* call("/list-models", { region });
            expectOk(body);
            const types = body.result.models.map((item: { type: string }) => item.type);
            expect(types).toContain("chat");
            expect(types).toContain("embedding");
          }),
        OPTIONS,
      );
    });

    describe("GetChatModel", () => {
      test.provider(
        "reads a chat model's context length",
        (_stack) =>
          Effect.gen(function* () {
            const { region, modelId } = yield* catalogueModel(CHEAP_CHAT_MODEL);
            const body = yield* call("/get-chat-model", { region, modelId });
            expectOk(body);
            expect(body.result.model.id).toEqual(modelId);
            expect(body.result.model.contextLength).toBeGreaterThan(0);
          }),
        OPTIONS,
      );
    });

    describe("GetEmbeddingModel", () => {
      test.provider(
        "reads an embedding model's output dimension",
        (_stack) =>
          Effect.gen(function* () {
            const { region, modelId } = yield* catalogueModel(CHEAP_EMBEDDING_MODEL);
            const body = yield* call("/get-embedding-model", { region, modelId });
            expectOk(body);
            expect(body.result.model.id).toEqual(modelId);
            expect(body.result.model.outputDimension).toBeGreaterThan(0);
          }),
        OPTIONS,
      );
    });

    describe("ChatCompletion", () => {
      test.provider(
        "generates a reply with the bound token",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/chat-completion");
            expectOk(body);
            expect(body.result.choices).toHaveLength(1);
            expect(body.result.usage.prompt_tokens).toBeGreaterThan(0);
            expect(body.result.usage.completion_tokens).toBeGreaterThan(0);
            expect(body.result.usage.completion_tokens).toBeLessThanOrEqual(32);
          }),
        OPTIONS,
      );

      test.provider(
        "types an unknown model",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/chat-completion-unknown-model");
            expectOk(body);
            expect(body.result.failed).toBe(true);
          }),
        OPTIONS,
      );
    });

    describe("StreamChatCompletion", () => {
      test.provider(
        "streams chunks up to a finish reason",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/stream-chat-completion");
            expectOk(body);
            expect(body.result.chunks).toBeGreaterThan(1);
            expect(body.result.finishReason).toEqual(expect.any(String));
            expect(body.result.completionTokens).toBeLessThanOrEqual(32);
          }),
        OPTIONS,
      );
    });

    describe("CreateEmbeddings", () => {
      test.provider(
        "embeds a sentence",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-embeddings");
            expectOk(body);
            expect(body.result.vectors).toEqual(1);
            expect(body.result.dimension).toBeGreaterThan(0);
          }),
        OPTIONS,
      );
    });

    describe("LanguageModel", () => {
      test.provider(
        "runs generateText through Effect AI",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/language-model");
            expectOk(body);
            expect(body.result.parts).toBeGreaterThan(0);
            expect(body.result.outputTokens).toBeGreaterThan(0);
            expect(body.result.outputTokens).toBeLessThanOrEqual(32);
          }),
        OPTIONS,
      );

      test.provider(
        "runs streamText through Effect AI",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/language-model-stream");
            expectOk(body);
            expect(body.result.finish).toEqual(1);
            expect(body.result.deltas).toBeGreaterThan(0);
          }),
        OPTIONS,
      );

      test.provider(
        "turns a tool call into a tool-call part",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/language-model-tool");
            expectOk(body);
            expect(body.result.toolCalls).toEqual(["get_answer"]);
          }),
        OPTIONS,
      );
    });

    // Out of band: the bound token is the one the stack deployed.
    describe("Token", () => {
      test.provider(
        "the bound token exists out of band while the stack is deployed",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stackitEnvironment;
            const { tokenId, name } = yield* stack;
            const live = yield* observeToken(projectId, region, tokenId);
            expect(live === "gone" ? "gone" : live.name).toEqual(name);
          }),
        OPTIONS,
      );
    });
  },
);
