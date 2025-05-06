/**
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
