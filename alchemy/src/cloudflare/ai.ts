/**
 * Cloudflare Workers AI binding for running machine learning models.
 *
 * The AI binding provides access to Cloudflare's Workers AI platform, allowing you to run
 * inference on various AI models including text generation, image classification, embeddings,
 * and more directly from your Workers.
 *
 * @example
 * ```ts
 * import { Ai } from "alchemy/cloudflare";
 *
 * const ai = new Ai();
 * ```
 *
 * @see https://developers.cloudflare.com/workers-ai/
 */
export class Ai<Models extends Record<string, any> = Record<string, any>> {
  public readonly type = "ai";

  /**
   * @internal
   */
  ///@ts-ignore
  _phantom: Models;
}
