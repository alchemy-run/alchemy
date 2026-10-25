import type * as Redacted from "effect/Redacted";

/** A Communication Services user access token (from `IssueAccessToken` or `CreateIdentity`). */
export type UserAccessToken = string | Redacted.Redacted<string>;

/** A chat request: the distilled request minus `endpoint`, plus the caller's user access token. */
export type ChatRequest<I> = Omit<I, "endpoint"> & {
  /**
   * Communication Services user access token of the chat participant the
   * call runs as (scope `chat`), from `IssueAccessToken` or `CreateIdentity`.
   */
  readonly userAccessToken: UserAccessToken;
};
