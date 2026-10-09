import * as SDK from "@distilled.cloud/anthropic";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Anthropic from "@/Anthropic";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Anthropic.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The Admin API (`/v1/organizations/*`) needs an Admin API key (or an OAuth
// token). Without one the lifecycle cannot run; the probe below proves the
// SDK refuses the call with a typed error instead of sending the inference key.
const hasAdminCreds = !!(process.env.ANTHROPIC_ADMIN_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Out-of-band: resolves once the Workspace reads as archived (or missing). */
const waitUntilArchived = (workspaceId: string) =>
  SDK.getWorkspace({ workspace_id: workspaceId }).pipe(
    Effect.map((workspace) => (workspace.archived_at === null ? "live" : "archived")),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("archived" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "archived",
      times: 10,
    }),
  );

test.provider.skipIf(hasAdminCreds || !process.env.ANTHROPIC_API_KEY)(
  "admin operations with only an inference key fail with MissingAnthropicCredentials",
  () =>
    Effect.gen(function* () {
      const error = yield* SDK.listWorkspaces({ limit: 1 }).pipe(Effect.flip);
      expect(error._tag).toBe("MissingAnthropicCredentials");
      if (error._tag === "MissingAnthropicCredentials") {
        expect(error.required).toBe("admin");
      }
    }),
  { tags: ["provider:anthropic", "provider:anthropic:workspace", "live"] },
);

describe.skipIf(!hasAdminCreds)("Anthropic.Workspace", () => {
  test.provider(
    "create, update and archive a workspace",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Anthropic.Workspace("Workspace", {
              tags: { env: "test" },
            });
          }),
        );

        expect(created.workspaceId).toMatch(/^wrkspc_/);
        expect(created.name.length).toBeLessThanOrEqual(40);
        expect(created.tags).toEqual({ env: "test" });

        const observed = yield* SDK.getWorkspace({ workspace_id: created.workspaceId });
        expect(observed.archived_at).toBeNull();
        expect(observed.name).toBe(created.name);
        expect(observed.tags).toMatchObject({ env: "test", "alchemy::id": "Workspace" });

        const renamed = `${created.name.slice(0, 32)}-renamed`;
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Anthropic.Workspace("Workspace", {
              name: renamed,
              displayColor: "#6C5BB9",
              tags: { team: "platform" },
            });
          }),
        );

        expect(updated.workspaceId).toBe(created.workspaceId);
        expect(updated.name).toBe(renamed);
        expect(updated.tags).toEqual({ team: "platform" });

        const reobserved = yield* SDK.getWorkspace({ workspace_id: created.workspaceId });
        expect(reobserved.name).toBe(renamed);
        expect(reobserved.display_color.toLowerCase()).toBe("#6c5bb9");
        expect(reobserved.tags.team).toBe("platform");
        expect(reobserved.tags.env).toBeUndefined();
        expect(reobserved.tags["alchemy::id"]).toBe("Workspace");

        yield* stack.destroy();

        expect(yield* waitUntilArchived(created.workspaceId)).toBe("archived");
      }).pipe(logLevel),
    { tags: ["provider:anthropic", "provider:anthropic:workspace", "live"], timeout: 120_000 },
  );

  test.provider(
    "recreates a workspace archived out of band",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const app = (round: string) =>
          Effect.gen(function* () {
            return yield* Anthropic.Workspace("Recreated", { tags: { round } });
          });

        const first = yield* stack.deploy(app("1"));
        yield* SDK.archiveWorkspace({ workspace_id: first.workspaceId });
        expect(yield* waitUntilArchived(first.workspaceId)).toBe("archived");

        // A prop change forces reconcile, which observes the archived
        // workspace as missing and creates a fresh one.
        const second = yield* stack.deploy(app("2"));
        expect(second.workspaceId).not.toBe(first.workspaceId);
        const observed = yield* SDK.getWorkspace({ workspace_id: second.workspaceId });
        expect(observed.archived_at).toBeNull();

        yield* stack.destroy();

        expect(yield* waitUntilArchived(second.workspaceId)).toBe("archived");
      }).pipe(logLevel),
    { tags: ["provider:anthropic", "provider:anthropic:workspace", "live"], timeout: 120_000 },
  );
});
