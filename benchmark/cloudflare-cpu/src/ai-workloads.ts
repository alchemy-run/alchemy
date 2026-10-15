import { Buffer } from "node:buffer";
import { makeLanguageModel, type LanguageModelClient } from "alchemy/Cloudflare/AI";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { type AiError, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** CPU-only adapter diagnostic: the Ai.run implementation performs no I/O. */
export const aiWorkloadDescription =
  "Actual Workers AI LanguageModel adapter with an in-memory validating Ai.run sink; excludes remote inference.";
export const maximumAiImages = 20;
export const maximumAiToolCalls = 500;
export const aiImageBytes = 1024 * 1024;
export const aiToolCount = 40;

const modelName = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const imageMediaType = "image/png";
const toolPrompt = "CPU tool schema benchmark";
const replyText = "adapter-ok";
const replyJson = JSON.stringify({ response: replyText });
type NativeAi = Effect.Success<LanguageModelClient["raw"]>;

export interface AiImageResult {
  readonly iterations: number;
  readonly bytes: number;
  readonly dataUrlCharacters: number;
  readonly checksum: number;
}

export interface AiToolsResult {
  readonly iterations: number;
  readonly tools: number;
  readonly schemaCharacters: number;
  readonly checksum: number;
}

export interface AiWorkloadsService {
  readonly aiImage: (count: number) => Effect.Effect<AiImageResult, AiError.AiError>;
  readonly aiTools: (count: number) => Effect.Effect<AiToolsResult, AiError.AiError>;
}

/** Optional service facade for harnesses that prefer to provide a Context. */
export class AiWorkloads extends Context.Service<AiWorkloads, AiWorkloadsService>()(
  "benchmark/cloudflare-cpu/AiWorkloads",
) {}

export const aiImage = (count: number) => AiWorkloads.use((workloads) => workloads.aiImage(count));
export const aiTools = (count: number) => AiWorkloads.use((workloads) => workloads.aiTools(count));

const requireCount = (count: number, maximum: number) => {
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new Error(`AI workload count must be an integer from 0 to ${maximum}`);
  }
};

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI workload received a non-object request field");
  }
  return value as Record<string, unknown>;
};

const messages = (input: unknown) => {
  const body = record(input);
  if (body.stream !== undefined && body.stream !== false) {
    throw new Error("AI workload unexpectedly requested streaming inference");
  }
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    throw new Error("AI workload changed its single-message prompt");
  }
  const message = record(body.messages[0]);
  if (message.role !== "user") throw new Error("AI workload changed the user role");
  return { body, message };
};

const checksumText = (value: string): number => {
  let checksum = 2166136261;
  for (let index = 0; index < value.length; index++) {
    checksum = Math.imul(checksum ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return checksum;
};

/**
 * Run ONCE in the Worker's init Effect, outside the measured request handlers.
 *
 * const ai = yield* makeAiWorkloads;
 * // In fetch: yield* ai.aiImage(count) / ai.aiTools(count).
 * // Or provide AiWorkloads with this value and use the exported facade functions.
 *
 * This constructs the 1 MiB offset view, expected URL, stable forty-tool toolkit,
 * ready handlers, and actual LanguageModel services once per isolate. Each call
 * below still executes the public LanguageModel generation path and the real
 * Alchemy prompt/base64/schema adapter. Only remote Ai.run inference is replaced.
 * The first tool request warms any adapter schema cache; exclude it from a warm
 * baseline/candidate cohort or report cold and warm samples separately.
 */
export const makeAiWorkloads: Effect.Effect<AiWorkloadsService> = Effect.gen(function* () {
  const fixture = yield* Effect.sync(() => {
    // Nonzero offset and suffix catch accidentally encoding the backing buffer.
    const storage = new Uint8Array(aiImageBytes + 34).fill(231);
    const image = storage.subarray(17, 17 + aiImageBytes);
    for (let index = 0; index < image.length; index++) image[index] = (index * 73 + 19) & 255;
    const expectedImageUrl = `data:${imageMediaType};base64,${Buffer.from(
      image.buffer,
      image.byteOffset,
      image.byteLength,
    ).toString("base64")}`;
    const tools = Array.from({ length: aiToolCount }, (_, index) =>
      Tool.make(`tool_${String(index).padStart(2, "0")}`, {
        description: `Météo 東京 tool ${index}`,
        parameters: Schema.Struct({
          query: Schema.String.annotate({ description: "Requête / 検索" }),
          filters: Schema.Array(
            Schema.Struct({
              field: Schema.String,
              value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
            }),
          ),
          settings: Schema.Struct({
            limit: Schema.NumberFromString,
            include: Schema.Array(Schema.String),
            mode: Schema.Literals(["fast", "thorough"]),
          }),
        }),
      }),
    );
    // This reference conversion is outside the measured workload. Compare full
    // tool definitions, not merely tool count, to catch corrupted nested schemas.
    const expectedToolsJson = JSON.stringify(
      tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: Tool.getDescription(tool),
          parameters: Tool.getJsonSchema(tool),
        },
      })),
    );
    return {
      image,
      expectedImageUrl,
      imageChecksum: checksumText(expectedImageUrl),
      tools,
      expectedToolsJson,
      toolsChecksum: checksumText(expectedToolsJson),
    };
  });

  const makeSink = (validate: (input: unknown) => void): NativeAi =>
    ({
      // This is the exact asynchronous API boundary the production adapter calls.
      // No URL is fetched and no real binding is consulted.
      run: async (model: string, input: unknown, options: unknown) => {
        if (model !== modelName || record(options).returnRawResponse !== true) {
          throw new Error("AI workload changed model or raw-response options");
        }
        validate(input);
        return new Response(replyJson, { headers: { "content-type": "application/json" } });
      },
    }) as unknown as NativeAi;

  const imageAi = makeSink((input) => {
    const { body, message } = messages(input);
    if (body.tools !== undefined || body.tool_choice !== undefined) {
      throw new Error("AI image workload unexpectedly attached tools");
    }
    if (!Array.isArray(message.content) || message.content.length !== 1) {
      throw new Error("AI image workload changed its image content");
    }
    const part = record(message.content[0]);
    if (part.type !== "image_url" || record(part.image_url).url !== fixture.expectedImageUrl) {
      throw new Error("AI adapter changed image bytes, offset, MIME type or base64 encoding");
    }
  });

  const toolsAi = makeSink((input) => {
    const { body, message } = messages(input);
    if (message.content !== toolPrompt || body.tool_choice !== "auto") {
      throw new Error("AI tool workload changed its prompt or tool choice");
    }
    if (
      !Array.isArray(body.tools) ||
      body.tools.length !== aiToolCount ||
      JSON.stringify(body.tools) !== fixture.expectedToolsJson
    ) {
      throw new Error("AI adapter changed a tool name, description or nested schema");
    }
  });

  const imageModel = yield* makeLanguageModel({
    model: modelName,
    client: { raw: Effect.succeed(imageAi) },
  }).pipe(Effect.provide(RuntimeContext.phantom));
  const toolsModel = yield* makeLanguageModel({
    model: modelName,
    client: { raw: Effect.succeed(toolsAi) },
  }).pipe(Effect.provide(RuntimeContext.phantom));

  const toolkit = Toolkit.make(...fixture.tools);
  const readyToolkit = yield* toolkit.pipe(
    Effect.provide(
      toolkit.toLayer(
        Object.fromEntries(fixture.tools.map((tool) => [tool.name, () => Effect.void])),
      ),
    ),
  );
  const imagePrompt = [
    {
      role: "user" as const,
      content: [
        {
          type: "file" as const,
          mediaType: imageMediaType,
          data: fixture.image,
        },
      ],
    },
  ];

  return {
    aiImage: (count) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => requireCount(count, maximumAiImages));
        let checksum = 0;
        for (let index = 0; index < count; index++) {
          const result = yield* imageModel.generateText({ prompt: imagePrompt });
          if (result.text !== replyText)
            return yield* Effect.die(new Error("Invalid AI image response"));
          checksum = (checksum + fixture.imageChecksum) >>> 0;
        }
        return {
          iterations: count,
          bytes: count * aiImageBytes,
          dataUrlCharacters: count * fixture.expectedImageUrl.length,
          checksum,
        };
      }),
    aiTools: (count) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => requireCount(count, maximumAiToolCalls));
        let checksum = 0;
        for (let index = 0; index < count; index++) {
          const result = yield* toolsModel.generateText({
            prompt: toolPrompt,
            toolkit: readyToolkit,
            toolChoice: "auto",
          });
          if (result.text !== replyText)
            return yield* Effect.die(new Error("Invalid AI tools response"));
          checksum = (checksum + fixture.toolsChecksum) >>> 0;
        }
        return {
          iterations: count,
          tools: count * aiToolCount,
          schemaCharacters: count * fixture.expectedToolsJson.length,
          checksum,
        };
      }),
  } satisfies AiWorkloadsService;
});
