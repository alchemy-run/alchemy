import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { ListMessages } from "./ListMessages.ts";
import { listMessagesOperation } from "./ListMessagesHttp.ts";

/** {@link ListMessages} off the provider's ambient credentials (laptop / tests). */
export const ListMessagesLocal = Layer.effect(
  ListMessages,
  BindingLocal.make(listMessagesOperation),
);
