/**
 * An ingress module for `Ingress.test.ts`: the `@alchemy.run/test` forwarder
 * as its default-export Router Layer, counting how many times it is built.
 */
import { make } from "@alchemy.run/test/IngressForwarder";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const builds = { count: 0 };

export default Layer.merge(make(), Layer.effectDiscard(Effect.sync(() => void builds.count++)));
