import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";
import { v4 as uuidv4 } from "uuid";

export type UserId = string;
export const UserId = S.String;

export class User extends S.Class<User>("User")({
  userId: UserId,
  firstName: S.String,
  lastName: S.String,
}) {}

export class Users extends ServiceMap.Service<Users, UserService>()("Users") {}

export interface UserService {
  getUser(userId: string): Effect.Effect<User | undefined>;
  createUser(firstName: string, lastName: string): Effect.Effect<UserId>;
}

export const UsersDurableObject = Layer.effect(
  Users,
  Effect.gen(function* () {
    const users = yield* Cloudflare.DurableObjectNamespace(
      "User",
      Effect.gen(function* () {
        const state = yield* Cloudflare.DurableObjectState;
        return {
          getProfile: () =>
            Effect.sync(() => state.storage.kv.get("profile") as User),
          setProfile: (firstName: string, lastName: string) =>
            Effect.sync(() =>
              state.storage.kv.put("profile", {
                firstName,
                lastName,
              }),
            ),
        };
      }),
    );

    return {
      getUser: Effect.fnUntraced(function* (userId) {
        const user = yield* users.getByName(userId);
        return yield* user.getProfile();
      }),
      createUser: Effect.fnUntraced(function* (firstName, lastName) {
        const userId = yield* Effect.sync(() => uuidv4());
        const user = yield* users.getByName(userId);
        yield* user.setProfile(firstName, lastName);
        return userId;
      }),
    };
  }),
);
