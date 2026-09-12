import * as Layer from "effect/Layer";
import * as BindingLocal from "./BindingLocal.ts";
import { CreateMessage } from "./CreateMessage.ts";
import { createMessageOperation } from "./CreateMessageHttp.ts";

/** {@link CreateMessage} off the provider's ambient credentials (laptop / tests). */
export const CreateMessageLocal = Layer.effect(
  CreateMessage,
  BindingLocal.make(createMessageOperation),
);
