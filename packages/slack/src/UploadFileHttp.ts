import * as Files from "@distilled.cloud/slack/files";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { makeAuthorizedCaller } from "./BindingHttp.ts";
import type { Channel } from "./Channel.ts";
import { FileUploadFailed, UploadFile, type UploadFileRequest } from "./UploadFile.ts";

/**
 * Bot-token implementation of {@link UploadFile}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product File
 * @provides Slack.UploadFile
 */
export const UploadFileHttp = Layer.effect(
  UploadFile,
  Effect.gen(function* () {
    const call = yield* makeAuthorizedCaller;
    return Effect.fn(function* (channel: Channel) {
      const channelId = yield* channel.channelId;
      return Effect.fn(`Slack.UploadFile(${channel.LogicalId})`)(function* (
        request: UploadFileRequest,
      ) {
        const bytes =
          typeof request.content === "string"
            ? new TextEncoder().encode(request.content)
            : request.content;
        const target = yield* call(
          Files.getUploadURLExternal({
            filename: request.filename,
            length: bytes.byteLength,
            alt_txt: request.altText,
          }),
        );
        // The upload URL is one Slack handed back to use as-is (presigned),
        // so it is called directly rather than through distilled.
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(target.upload_url).pipe(
            HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
          ),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError(
            (cause) => new FileUploadFailed({ status: 0, message: String(cause.message) }),
          ),
        );
        if (response.status >= 300) {
          return yield* new FileUploadFailed({
            status: response.status,
            message: `Slack upload URL answered HTTP ${response.status}`,
          });
        }
        return yield* call(
          Files.completeUploadExternal({
            files: [{ id: target.file_id, title: request.title ?? request.filename }],
            channel_id: yield* channelId,
            initial_comment: request.initialComment,
            thread_ts: request.threadTs,
          }),
        );
      });
    });
  }),
);
