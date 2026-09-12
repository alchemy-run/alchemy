import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  CreateMessage,
  type CreateMessageRequest,
  type CreateMessageResponse,
} from "./CreateMessage.ts";

export const createMessageOperation = BindingHttp.operation(
  "channels.createMessage",
  (rest) =>
    ({ channel_id, ...body }: CreateMessageRequest) =>
      rest.request<CreateMessageResponse>({
        method: "POST",
        path: `/channels/${channel_id}/messages`,
        body,
      }),
);

/**
 * Token-backed {@link CreateMessage}: captures the provider credential
 * as a `Discord.BotToken` resource bound into the host.
 */
export const CreateMessageHttp = Layer.effect(
  CreateMessage,
  BindingHttp.make(createMessageOperation),
);
