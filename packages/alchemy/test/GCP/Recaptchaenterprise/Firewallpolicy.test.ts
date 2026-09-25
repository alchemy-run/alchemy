import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  recaptchaenterprise.getProjectsFirewallpolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a firewall policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* recaptchaenterprise
        .listProjectsFirewallpolicies({
          parent: `projects/${project}`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
        );
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Recaptchaenterprise.Firewallpolicy("Login", {
            path: "/login",
            description: "allow login",
            actions: [{ allow: {} }],
          });
        }),
      );

      expect(created.name).toContain("/firewallpolicies/");
      expect(created.firewallpolicyId).toEqual(expect.any(String));
      expect(created.path).toEqual("/login");
      expect(created.description).toEqual("allow login");
      expect(created.actions[0]?.allow).toEqual({});

      const fetched = yield* recaptchaenterprise.getProjectsFirewallpolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.path).toEqual("/login");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("allow login");
      expect(fetched.actions?.[0]?.allow).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Recaptchaenterprise.Firewallpolicy("Login", {
            firewallpolicyId: created.firewallpolicyId,
            path: "/signin",
            description: "allow sign-in",
            actions: [{ block: {} }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.firewallpolicyId).toEqual(created.firewallpolicyId);
      expect(updated.path).toEqual("/signin");
      expect(updated.description).toEqual("allow sign-in");
      expect(updated.actions[0]?.block).toEqual({});

      const fetchedUpdate =
        yield* recaptchaenterprise.getProjectsFirewallpolicies({
          name: created.name,
        });
      expect(fetchedUpdate.path).toEqual("/signin");
      expect(fetchedUpdate.description).toContain("allow sign-in");
      expect(fetchedUpdate.actions?.[0]?.block).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
