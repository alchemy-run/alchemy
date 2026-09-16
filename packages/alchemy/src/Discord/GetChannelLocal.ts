import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { GetChannel } from "./GetChannel.ts";
import { getChannelOperation } from "./GetChannelHttp.ts";

/** {@link GetChannel} off the provider's ambient credentials (laptop / tests). */
export const GetChannelLocal = Layer.effect(
  GetChannel,
  BindingLocal.make(getChannelOperation),
);
