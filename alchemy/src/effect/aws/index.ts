import * as Layer from "effect/Layer";
import * as Account from "./account-id.ts";
import * as Lambda from "./function.ts";
import * as Queue from "./queue.ts";
import * as STS from "./sts.ts";

export const providers = Layer.merge(
  Layer.provide(Lambda.provider, Lambda.client),
  Layer.provide(Queue.provider, Queue.client),
);

export const defaultProviders = providers.pipe(
  Layer.provideMerge(Account.fromIdentity),
  Layer.provide(STS.client),
);
