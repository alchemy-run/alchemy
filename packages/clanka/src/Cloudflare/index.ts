/**
 * clanka on Cloudflare: conversations in a Durable Object's storage.
 *
 * @module
 */
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ClankaError } from "../Errors.ts";
import { Store, type InstanceStore } from "../Store.ts";

/** One stored value stays under the 128 KiB a Durable Object key holds. */
const CHUNK = 100_000;

interface KeyValue {
  get(key: string): Promise<string | number | undefined>;
  put(entries: Record<string, string | number>): Promise<void>;
  delete(keys: Array<string>): Promise<number>;
}

/**
 * Conversations in the Durable Object's own storage. A conversation is
 * saved after every prompt, so it continues after the instance is evicted
 * or redeployed. A prompt cut off before it finishes leaves the
 * conversation as it was and is not resumed: send it again.
 *
 * **Example:** A harness whose conversations outlive the instance
 * ```typescript
 * const HarnessLive = Layer.mergeAll(FastLive, ClankaCloudflare.DurableObjectStore);
 * ```
 *
 * @layer
 * @provides Clanka.Store
 */
export const DurableObjectStore: Layer.Layer<Store> = Layer.succeed(Store, {
  instance: Effect.map(Effect.serviceOption(DurableObjectState), (state) => {
    const use = <A>(operation: string, run: (storage: KeyValue) => Promise<A>) =>
      Option.isNone(state)
        ? Effect.fail(
            new ClankaError({
              message:
                "ClankaCloudflare.DurableObjectStore is only available inside a Durable Object",
            }),
          )
        : Effect.tryPromise({
            try: () => run((state.value.raw as unknown as { storage: KeyValue }).storage),
            catch: (cause) =>
              new ClankaError({ message: `Durable Object storage failed (${operation})`, cause }),
          });
    const prefix = (key: string) => `clanka:${key}:`;
    const store: InstanceStore = {
      // At plan time the state is a stand-in with no id, and nothing reads the store.
      id: Option.match(state, { onNone: () => "", onSome: (state) => state.id?.toString() ?? "" }),
      get: (key) =>
        use("get", async (storage) => {
          const count = await storage.get(`${prefix(key)}n`);
          if (typeof count !== "number") return undefined;
          const parts = await Promise.all(
            Array.from({ length: count }, (_, index) => storage.get(`${prefix(key)}${index}`)),
          );
          return parts.join("");
        }),
      put: (key, value) =>
        use("put", async (storage) => {
          const previous = await storage.get(`${prefix(key)}n`);
          const count = Math.max(1, Math.ceil(value.length / CHUNK));
          for (let index = 0; index < count; index++) {
            await storage.put({
              [`${prefix(key)}${index}`]: value.slice(index * CHUNK, (index + 1) * CHUNK),
            });
          }
          // The count is written last: a reader never sees a half-written value as whole.
          await storage.put({ [`${prefix(key)}n`]: count });
          if (typeof previous === "number" && previous > count) {
            await storage.delete(
              Array.from(
                { length: previous - count },
                (_, index) => `${prefix(key)}${count + index}`,
              ),
            );
          }
        }),
      delete: (key) =>
        use("delete", async (storage) => {
          const count = await storage.get(`${prefix(key)}n`);
          if (typeof count !== "number") return;
          await storage.delete([
            `${prefix(key)}n`,
            ...Array.from({ length: count }, (_, index) => `${prefix(key)}${index}`),
          ]);
        }),
    };
    return store;
  }),
});
