import type * as Files from "@distilled.cloud/slack/files";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export interface UploadFileRequest {
  /** File name, with extension (`report.csv`). */
  filename: string;
  /** The file's bytes, or text. */
  content: Uint8Array | string;
  /** Title shown above the file. Defaults to the file name. */
  title?: string;
  /** Message posted with the file. */
  initialComment?: string;
  /** Share into this thread instead of the channel. */
  threadTs?: string;
  /** Alt text for an image. */
  altText?: string;
}

/** Slack's upload URL refused the file bytes. */
export class FileUploadFailed extends Data.TaggedError("Slack.FileUploadFailed")<{
  readonly status: number;
  readonly message: string;
}> {}

/**
 * Upload a file and share it into the bound channel. Uses Slack's external
 * upload flow: `files.getUploadURLExternal`, a POST of the bytes to the URL it
 * returns, then `files.completeUploadExternal` with the channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.UploadFileHttp` on the Worker or Function.
 *
 * Needs the bot scope `files:write`.
 *
 * ### Calling it at runtime
 * **Example:** Share a CSV report
 * ```typescript
 * const upload = yield* Slack.UploadFile(reports);
 * yield* upload({
 *   filename: "daily.csv",
 *   content: "date,signups\n2026-11-20,42\n",
 *   initialComment: "Today's numbers",
 * });
 * ```
 *
 * @binding
 * @product File
 */
export interface UploadFile extends Binding.Service<
  UploadFile,
  "Slack.UploadFile",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: UploadFileRequest,
    ) => Effect.Effect<
      Files.CompleteUploadExternalResponse,
      Files.GetUploadURLExternalError | Files.CompleteUploadExternalError | FileUploadFailed,
      RuntimeContext
    >
  >
> {}

export const UploadFile = Binding.Service<UploadFile>("Slack.UploadFile");
