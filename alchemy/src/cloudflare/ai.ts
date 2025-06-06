/**
 * Cloudflare Workers AI binding for running machine learning models.
 *
 * The AI binding provides access to Cloudflare's Workers AI platform, allowing you to run
 * inference on various AI models including text generation, image classification, embeddings,
 * and more directly from your Workers.
 *
 * @example
 * ```ts
 * import { Worker, Ai } from "alchemy/cloudflare";
 *
 * const ai = new Ai();
 *
 * await Worker("my-worker", {
 *   name: "my-worker",
 *   entrypoint: "./src/worker.ts",
 *   bindings: {
 *     AI: ai
 *   }
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/workers-ai/
 */
export class Ai<Models extends AiModelListType = AiModelListType> {
  public readonly type = "ai";

  /**
   * @internal
   */
  ///@ts-ignore
  _phantom: Models;
}
