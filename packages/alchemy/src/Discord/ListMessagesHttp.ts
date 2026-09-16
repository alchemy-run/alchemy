import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  ListMessages,
  type ListMessagesRequest,
  type ListMessagesResponse,
} from "./ListMessages.ts";

export const listMessagesOperation = BindingHttp.operation(
  "channels.listMessages",
  (rest) =>
    ({ channel_id, ...query }: ListMessagesRequest) =>
      rest.request<ListMessagesResponse>({
        method: "GET",
        path: `/channels/${channel_id}/messages`,
        query,
      }),
);

/**
 * Token-backed {@link ListMessages}: captures the provider credential
 * as a `Discord.BotToken` resource bound into the host.
 */
export const ListMessagesHttp = Layer.effect(
  ListMessages,
  BindingHttp.make(listMessagesOperation),
);
