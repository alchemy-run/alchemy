import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GcpProjectMissing } from "../Environment.ts";
import * as GCPBindings from "../GCPBindings.ts";

/**
 * A Vertex AI publisher model, e.g. Gemini. Publisher models are not
 * Alchemy resources — they are addressed by id under a location.
 */
export interface PublisherModel {
  /**
   * Model id, e.g. `gemini-2.5-flash`.
   */
  model: string;
  /**
   * Vertex AI location serving the model. `global` routes to any region
   * with capacity; pin a region (e.g. `us-central1`) for data residency.
   * @default "global"
   */
  location?: string;
  /**
   * Model publisher.
   * @default "google"
   */
  publisher?: string;
}

export interface GenerateContentRequest
  extends aiplatform.GoogleCloudAiplatformV1GenerateContentRequest {}

export type GenerateContentError =
  | aiplatform.GenerateContentProjectsLocationsPublishersModelsError
  | GcpProjectMissing;

/**
 * Runtime client returned by {@link GenerateContent}.
 */
export interface GenerateContentClient {
  /**
   * Full `generateContent` call against the bound model.
   */
  generate(
    request: GenerateContentRequest,
  ): Effect.Effect<
    aiplatform.GoogleCloudAiplatformV1GenerateContentResponse,
    GenerateContentError,
    RuntimeContext
  >;
  /**
   * Single-turn text generation: sends `prompt` as one user turn and
   * returns the concatenated text parts of the first candidate.
   * `options` is merged into the request (generation config, system
   * instruction, safety settings, ...).
   */
  text(
    prompt: string,
    options?: Omit<GenerateContentRequest, "contents">,
  ): Effect.Effect<string, GenerateContentError, RuntimeContext>;
}

/**
 * Runtime binding for Vertex AI `generateContent` on a publisher model
 * (Gemini).
 *
 * Bind it in a Function/Job init phase with a model id or a
 * {@link PublisherModel} descriptor and provide
 * {@link GenerateContentHttp}. At deploy time it grants the host's
 * runtime service account `roles/aiplatform.user` on the project —
 * Vertex AI publisher models have no resource-level IAM policy.
 *
 * ### Generating Text
 * **Example:** Ask Gemini a question
 * ```typescript
 * const gemini = yield* GCP.AIPlatform.GenerateContent("gemini-2.5-flash");
 * const answer = yield* gemini.text("Name three primary colors.");
 * ```
 *
 * **Example:** Pin a region and tune generation
 * ```typescript
 * const gemini = yield* GCP.AIPlatform.GenerateContent({
 *   model: "gemini-2.5-flash",
 *   location: "us-central1",
 * });
 * const answer = yield* gemini.text("Write a haiku about rain.", {
 *   generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
 * });
 * ```
 *
 * ### Full Requests
 * **Example:** Multi-turn chat with a system instruction
 * ```typescript
 * const response = yield* gemini.generate({
 *   systemInstruction: { parts: [{ text: "Answer in one sentence." }] },
 *   contents: [
 *     { role: "user", parts: [{ text: "What is Cloud Run?" }] },
 *     { role: "model", parts: [{ text: "A serverless container platform." }] },
 *     { role: "user", parts: [{ text: "How is it billed?" }] },
 *   ],
 * });
 * const usage = response.usageMetadata?.totalTokenCount;
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface GenerateContent extends Binding.Service<
  GenerateContent,
  "GCP.AIPlatform.GenerateContent",
  (model: string | PublisherModel) => Effect.Effect<GenerateContentClient>
> {}

export const GenerateContent = Binding.Service<GenerateContent>("GCP.AIPlatform.GenerateContent");

const TAG = "GCP.AIPlatform.GenerateContent";

/**
 * HTTP implementation of {@link GenerateContent}.
 *
 * @layer
 * @provides GCP.AIPlatform.GenerateContent
 */
export const GenerateContentHttp = Layer.effect(
  GenerateContent,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const generateContent = yield* GCPBindings.withCredentials(
      aiplatform.generateContentProjectsLocationsPublishersModels,
    );
    // The project is the caller's own: deploy credentials at plan time,
    // the metadata server inside Cloud Run / Cloud Functions.
    const credentials = Context.get(
      yield* GCPBindings.withCredentials(Effect.context<Credentials>()),
      Credentials,
    );
    const project = credentials.pipe(
      Effect.flatMap(({ project }) =>
        project
          ? Effect.succeed(project)
          : Effect.fail(
              new GcpProjectMissing({
                message: `${TAG}: no GCP project id in the runtime credentials`,
              }),
            ),
      ),
    );

    return Effect.fn(function* (target: string | PublisherModel) {
      const {
        model,
        location = "global",
        publisher = "google",
      } = typeof target === "string" ? { model: target } : target;
      const id = `${publisher}/${model}@${location}`;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${TAG}(${{ LogicalId: id }})`({
          // Publisher models have no resource IAM policy; aiplatform.user is
          // the narrowest predefined role carrying aiplatform.endpoints.predict.
          iam: [{ role: "roles/aiplatform.user" }],
        });
      }

      const generate = Effect.fn(`${TAG}(${id})`)(function* (request: GenerateContentRequest) {
        return yield* generateContent({
          model: `projects/${yield* project}/locations/${location}/publishers/${publisher}/models/${model}`,
          body: request,
        });
      });

      const client: GenerateContentClient = {
        generate,
        text: (prompt, options) =>
          generate({
            ...options,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          }).pipe(
            Effect.map((response) =>
              (response.candidates?.[0]?.content?.parts ?? [])
                .filter((part) => !part.thought)
                .map((part) => part.text ?? "")
                .join(""),
            ),
          ),
      };
      return client;
    });
  }),
);
