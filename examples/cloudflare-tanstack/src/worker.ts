import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

const gen = Effect.gen(function* () {
  const users = yield* Cloudflare.DurableObjectNamespace(
    "Users",
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        getProfile: () => state.storage.get<any>("Profile"),
        putProfile: (value: string) => state.storage.put("Profile", value),
      };
    }),
  );

  return {
    getProfile: (name: string) =>
      Effect.flatMap(users.getByName(name), (user) => user.getProfile()),
    putProfile: (name: string, value: string) =>
      Effect.flatMap(users.getByName(name), (user) => user.putProfile(value)),
  };
});

const Website = Cloudflare.TanstackStart("Website")(gen);

export default Website;
