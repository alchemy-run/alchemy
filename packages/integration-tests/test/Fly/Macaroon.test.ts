import { ACTION_ALL, attenuate, type Caveat } from "@alchemy.run/fly/Macaroon";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// Expected values are `fly tokens attenuate` output for the same token and
// caveats. The token is a permission macaroon signed with a throwaway key.
// Stored without their `fm2_` labels so they don't read as live tokens.
const BASE =
  "lJPEAwkIB8QQQkJCQkJCQkJCQkJCQkJCQsK1aHR0cHM6Ly9hcGkuZmx5LmlvL3YxkMQgEY/cBXfHyTMq7ULRZXzbqlOZiCXTxrzLSnMz9T++okY=";
// A macaroon at another location, standing in for a discharge token.
const OTHER = "lJPEAQHEAQLCpW90aGVykMQgBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const ONE_APP =
  "lJPEAwkIB8QQQkJCQkJCQkJCQkJCQkJCQsK1aHR0cHM6Ly9hcGkuZmx5LmlvL3YxkgORgc4AvGFOH8QgC63mT99IB1BxKTpzoTmJoHUKyeOYUsY5OTjUbqGeSuw=";
const TWO_APPS_WINDOW =
  "lJPEAwkIB8QQQkJCQkJCQkJCQkJCQkJCQsK1aHR0cHM6Ly9hcGkuZmx5LmlvL3YxlAORggUBzwAAABBMUzwAHwSSzmkcQ6DOaRxRsMQgEBzbm63JMQMP41xjKOnh6uIrRQBzAW6VzUSzr9tHxes=";

const token = (...macaroons: string[]) =>
  Redacted.make(`FlyV1 ${macaroons.map((m) => `fm2_${m}`).join(",")}`);
const oneApp: Caveat[] = [{ type: "Apps", apps: new Map([[12_345_678, ACTION_ALL]]) }];

const narrowed = (from: Redacted.Redacted<string>, caveats: readonly Caveat[]) =>
  attenuate(from, caveats).pipe(Effect.map(Option.map(Redacted.value)));

const tags = ["unit", "local", "provider:fly"];

it.effect(
  "narrows a token as `fly tokens attenuate` does",
  () =>
    Effect.gen(function* () {
      expect(yield* narrowed(token(BASE), oneApp)).toEqual(Option.some(`FlyV1 fm2_${ONE_APP}`));
      expect(
        yield* narrowed(token(BASE), [
          {
            type: "Apps",
            apps: new Map([
              [70_000_000_000, ACTION_ALL],
              [5, 0x01],
            ]),
          },
          { type: "ValidityWindow", notBefore: 1763460000, notAfter: 1763463600 },
        ]),
      ).toEqual(Option.some(`FlyV1 fm2_${TWO_APPS_WINDOW}`));
    }),
  { tags },
);

it.effect(
  "narrows only the permission token and puts discharge tokens after it, as flyctl does",
  () =>
    Effect.gen(function* () {
      expect(yield* narrowed(token(OTHER, BASE), oneApp)).toEqual(
        Option.some(`FlyV1 fm2_${ONE_APP},fm2_${OTHER}`),
      );
    }),
  { tags },
);

it.effect(
  "leaves a token that is not a Fly macaroon alone",
  () =>
    Effect.gen(function* () {
      expect(yield* narrowed(Redacted.make("a-legacy-personal-token"), oneApp)).toEqual(
        Option.none(),
      );
      expect(yield* narrowed(token(OTHER), oneApp)).toEqual(Option.none());
    }),
  { tags },
);
