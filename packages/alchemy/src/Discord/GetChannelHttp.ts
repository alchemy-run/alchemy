import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import {
  type Channel,
  GetChannel,
  type GetChannelRequest,
} from "./GetChannel.ts";

export const getChannelOperation = BindingHttp.operation(
  "channels.getChannel",
  (rest) => (request: GetChannelRequest) =>
    rest.request<Channel>({
      method: "GET",
      path: `/channels/${request.channel_id}`,
    }),
);

/**
 * Token-backed {@link GetChannel}: captures the provider credential as
 * a `Discord.BotToken` resource bound into the host.
 */
export const GetChannelHttp = Layer.effect(
  GetChannel,
  BindingHttp.make(getChannelOperation),
);
