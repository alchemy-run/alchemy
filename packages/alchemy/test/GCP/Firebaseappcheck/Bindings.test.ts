import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  APP_CHECK_DISABLED,
  FIREBASE_DISABLED,
  hasGcpCreds,
  logLevel,
  probeAppCheck,
  resolveAppId,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "ExchangeDebugToken mints an App Check token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAppCheck();
      if (access !== "enabled") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(APP_CHECK_DISABLED);
        yield* stack.destroy();
        return;
      }

      const app = yield* resolveAppId();
      if (typeof app !== "string") {
        expect(app._tag).toEqual("Forbidden");
        expect(app.message).toContain(FIREBASE_DISABLED);
        yield* stack.destroy();
        return;
      }
      expect(app).not.toEqual("missing");
      if (app === "missing") {
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const debug = yield* GCP.Firebaseappcheck.AppsDebugToken("Local", {
            app,
            displayName: "alchemy-exchange",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* debug.name;
              const exchange =
                yield* GCP.Firebaseappcheck.ExchangeDebugToken(debug);
              return Effect.fn(function* () {
                return yield* exchange();
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.token).toEqual(expect.any(String));
      expect((out.token ?? "").length).toBeGreaterThan(8);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
