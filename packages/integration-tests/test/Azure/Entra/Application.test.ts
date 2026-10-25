import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { applicationGone, eventually, getApplication, purged } from "./graph.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const program = (props: { description: string; redirectUris: string[]; tags: string[] }) =>
  Effect.gen(function* () {
    const app = yield* Azure.Entra.Application("App", {
      description: props.description,
      web: { redirectUris: props.redirectUris },
      tags: props.tags,
    });
    return { app };
  });

// Entra applications are free.
test.provider(
  "create, update, and delete an Entra application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app } = yield* stack.deploy(
        program({
          description: "alchemy test app",
          redirectUris: ["https://localhost:3000/callback"],
          tags: ["team:test"],
        }),
      );
      expect(app.appId).toMatch(/^[0-9a-f-]{36}$/);
      expect(app.objectId).toMatch(/^[0-9a-f-]{36}$/);
      expect(app.signInAudience).toEqual("AzureADMyOrg");
      expect(app.tags).toEqual(["team:test"]);

      const observed = yield* getApplication(app.objectId);
      expect(observed.appId).toEqual(app.appId);
      expect(observed.description).toEqual("alchemy test app");
      expect(observed.web?.redirectUris).toEqual(["https://localhost:3000/callback"]);
      // Ownership is recorded in Graph's string tags next to the user's.
      expect(observed.tags).toContain("alchemy::id=App");
      expect(observed.tags).toContain("team:test");
      expect(
        (observed.tags ?? []).filter((t) => /^alchemy::(stack|stage)=.+/.test(t)).length,
      ).toEqual(2);
      expect(observed.tags?.length).toEqual(4);

      // In-place update of description, redirect URIs, and tags.
      const { app: updated } = yield* stack.deploy(
        program({
          description: "updated",
          redirectUris: ["https://localhost:3000/callback", "https://localhost:4000/callback"],
          tags: ["team:platform"],
        }),
      );
      expect(updated.objectId).toEqual(app.objectId);
      expect(updated.tags).toEqual(["team:platform"]);
      const reobserved = yield* eventually(
        getApplication(app.objectId),
        (a) => a.description === "updated" && (a.tags ?? []).includes("team:platform"),
      );
      expect(reobserved.description).toEqual("updated");
      expect([...(reobserved.web?.redirectUris ?? [])].sort()).toEqual([
        "https://localhost:3000/callback",
        "https://localhost:4000/callback",
      ]);
      expect(reobserved.tags).toContain("team:platform");
      expect(reobserved.tags).not.toContain("team:test");
      expect(reobserved.tags).toContain("alchemy::id=App");

      yield* stack.destroy();
      expect(yield* applicationGone(app.objectId)).toEqual("gone");
      expect(yield* purged(app.objectId)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:azure", "provider:azure:entra", "live"], timeout: 300_000 },
);
