import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe(
  "Render.NotificationSetting",
  { tags: ["provider:render", "live"], timeout: 120_000 },
  () => {
    t.test.provider(
      "looks up workspace notification settings, updates cleanly, and restores baseline",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const prov = yield* Provider.findProvider(Render.NotificationSetting);
          const initial = yield* prov.lookup!({});
          expect(initial?.ownerId).toBeDefined();
          if (!initial) return;

          const toggled = initial.notificationsToSend === "all" ? "failure" : "all";
          const restoreOriginal = Effect.gen(function* () {
            yield* stack.deploy(
              Render.NotificationSetting("WorkspaceNotify", {
                emailEnabled: initial.emailEnabled,
                previewNotificationsEnabled: initial.previewNotificationsEnabled,
                notificationsToSend: initial.notificationsToSend,
              }),
            );
            yield* stack.destroy();
          }).pipe(Effect.ignore);

          yield* Effect.gen(function* () {
            const program = Render.NotificationSetting("WorkspaceNotify", {
              emailEnabled: initial.emailEnabled,
              previewNotificationsEnabled: initial.previewNotificationsEnabled,
              notificationsToSend: toggled,
            });
            const updated = yield* stack.deploy(program);
            expect(updated.notificationsToSend).toBe(toggled);
            yield* expectAllNoop(stack, program);
          }).pipe(Effect.ensuring(restoreOriginal));
        }),
      { tags: ["provider:render", "live"], timeout: 120_000 },
    );
  },
);
