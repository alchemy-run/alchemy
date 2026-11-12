import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
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

test.provider(
  "a dashboard without state is adopted by name only with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Dashboards are named per stage so concurrent users never share one.
      const name = `Alchemy Adopt Test ${stack.stage}`;
      const program = (description: string, adoptIt?: boolean) => {
        const dashboard = Axiom.Dashboard("AdoptDashboard", {
          dashboard: { ...dashboardProps.dashboard, name, description },
        });
        return adoptIt === undefined ? dashboard : dashboard.pipe(adopt(adoptIt));
      };

      const initial = yield* stack.deploy(program("first"));

      // Wipe the dashboard's state; the dashboard stays in Axiom.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "AdoptDashboard" });
      }).pipe(Effect.provide(stack.state));

      // Dashboards carry no ownership marker, so one found by name is foreign.
      const refused = yield* stack.deploy(program("second")).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse", logicalId: "AdoptDashboard" });

      // Adoption updates the same dashboard in place: same uid, one copy.
      const adopted = yield* stack.deploy(program("second", true));
      expect(adopted.uid).toEqual(initial.uid);

      const provider = yield* Provider.findProvider(Axiom.Dashboard);
      const matches = (yield* provider.list()).filter((d) => d.dashboard?.name === name);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.dashboard?.description).toEqual("second");

      yield* stack.destroy();
      const after = yield* provider.list();
      expect(after.some((d) => d.dashboard?.name === name)).toBe(false);
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dashboard", "live"],
    timeout: 180_000,
  },
);
