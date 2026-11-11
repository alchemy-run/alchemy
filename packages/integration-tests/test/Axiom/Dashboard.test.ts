import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Minimal, deterministic dashboard document. `owner: ""` is required when
// authenticating with an API token (Axiom rewrites it to the org-shared
// X-AXIOM-EVERYONE); relative windows use the `qr-now-*` form.
const dashboardProps = {
  dashboard: {
    name: "Alchemy List Test",
    owner: "",
    description: "list() lifecycle test dashboard",
    charts: [],
    layout: [],
    refreshTime: 60,
    schemaVersion: 2,
    timeWindowStart: "qr-now-1h",
    timeWindowEnd: "qr-now",
  },
};

test.provider(
  "list enumerates the deployed dashboard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dashboard("ListDashboard", dashboardProps);
        }),
      );
      yield* expectFound(Axiom.Dashboard.lookup({ uid: deployed.uid }), deployed);

      const provider = yield* Provider.findProvider(Axiom.Dashboard);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((d) => d.uid === deployed.uid)).toBe(true);

      const found = all.find((d) => d.uid === deployed.uid);
      expect(found?.id).toEqual(deployed.id);
      expect(found?.dashboard.name).toEqual("Alchemy List Test");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:axiom", "provider:axiom:dashboard", "live"] },
);
