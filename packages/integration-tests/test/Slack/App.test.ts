import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Apps from "@distilled.cloud/slack/apps";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Slack.providers() });

const tags = ["provider:slack", "provider:slack:app", "live"];

/** The deployed manifest, or `undefined` once the app is gone. */
const exported = (appId: string) =>
  Slack.withAppConfigToken(
    Apps.exportManifest({ app_id: appId }).pipe(
      Effect.map((r) => r.manifest as Slack.AppManifest),
      Effect.catchTag(["AppNotFound", "InvalidAppId"], () => Effect.undefined),
    ),
  );

const manifest = (description: string, scopes: string[]): Slack.AppManifest => ({
  display_information: { description },
  features: { bot_user: { display_name: "alchemy-test-bot", always_online: false } },
  oauth_config: { scopes: { bot: scopes } },
});

test.provider(
  "create from a manifest, update it in place, delete on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Slack.App("Bot", { manifest: manifest("first", ["chat:write"]) }),
      );
      expect(created.appId).toMatch(/^A/);
      expect(created.clientId).toBeTruthy();
      expect(created.signingSecret && Redacted.value(created.signingSecret)).toBeTruthy();
      expect(created.oauthAuthorizeUrl).toContain("slack.com/oauth");
      // The generated name is the logical-ID-based physical name.
      const name = created.manifest.display_information?.name;
      expect(name).toBeTruthy();

      let deployed = yield* exported(created.appId);
      expect(deployed?.display_information?.description).toBe("first");
      expect(deployed?.oauth_config?.scopes?.bot).toEqual(["chat:write"]);

      const updated = yield* stack.deploy(
        Slack.App("Bot", { manifest: manifest("second", ["chat:write", "channels:read"]) }),
      );
      expect(updated.appId).toBe(created.appId);
      // Secrets only come back from create; an update keeps them.
      expect(updated.signingSecret && Redacted.value(updated.signingSecret)).toBe(
        created.signingSecret && Redacted.value(created.signingSecret),
      );
      deployed = yield* exported(created.appId);
      expect(deployed?.display_information?.description).toBe("second");
      expect(deployed?.oauth_config?.scopes?.bot).toEqual(["chat:write", "channels:read"]);
      expect(deployed?.display_information?.name).toBe(name);

      const plan = yield* stack.plan(
        Slack.App("Bot", { manifest: manifest("second", ["chat:write", "channels:read"]) }),
      );
      expect(plan.resources.Bot?.action).toEqual("noop");

      yield* stack.destroy();
      expect(yield* exported(created.appId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an app deleted out of band is recreated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* stack.deploy(Slack.App("Gone", { manifest: manifest("gone", []) }));
      yield* Slack.withAppConfigToken(Apps.deleteManifest({ app_id: first.appId }));

      const second = yield* stack.deploy(Slack.App("Gone", { manifest: manifest("back", []) }));
      expect(second.appId).not.toBe(first.appId);
      expect((yield* exported(second.appId))?.display_information?.description).toBe("back");

      yield* stack.destroy();
      expect(yield* exported(second.appId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an invalid manifest fails with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack
        .deploy(
          Slack.App("Invalid", {
            manifest: { ...manifest("bad", ["not-a-real-scope"]) },
          }),
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).toContain("InvalidManifest");
      yield* stack.destroy();
    }),
  { tags, timeout: 60_000 },
);
