import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as webhooks from "@distilled.cloud/vercel/webhooks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/** Out-of-band read via distilled; `undefined` = webhook does not exist. */
const getHook = (id: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* webhooks.getWebhook({ id, ...team }).pipe(
      Effect.map((hook): webhooks.GetWebhookResponse | undefined => hook),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

test.provider("create webhook with url and events", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const hook = yield* stack.deploy(
      Vercel.Webhook("Hook", {
        url: "https://example.com/alchemy/webhook-create",
        events: ["deployment.created"],
      }),
    );

    expect(hook.webhookId).toBeDefined();
    expect(hook.url).toEqual("https://example.com/alchemy/webhook-create");
    expect(hook.events).toEqual(["deployment.created"]);
    expect(hook.ownerId).toBeDefined();
    // The signing secret is returned exactly once at create — the provider
    // must have persisted it into the attributes.
    expect(hook.secret.length).toBeGreaterThan(0);

    // Out-of-band verification via distilled: live and listed.
    const fetched = yield* getHook(hook.webhookId);
    expect(fetched).toBeDefined();
    expect(fetched!.url).toEqual("https://example.com/alchemy/webhook-create");
    expect([...fetched!.events]).toEqual(["deployment.created"]);

    const team = yield* teamScope;
    // The list response is a union of two array shapes; both items carry `id`.
    const listed: ReadonlyArray<{ id: string }> = yield* webhooks.getWebhooks({
      ...team,
    });
    expect(listed.some((h) => h.id === hook.webhookId)).toBe(true);

    yield* stack.destroy();
    expect(yield* getHook(hook.webhookId)).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("changing the event list replaces the webhook", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const first = yield* stack.deploy(
      Vercel.Webhook("ReplaceHook", {
        url: "https://example.com/alchemy/webhook-replace",
        events: ["deployment.created"],
      }),
    );

    // Same props (events reordered = same set) is a no-op: same id, same
    // secret, no replacement.
    const noop = yield* stack.deploy(
      Vercel.Webhook("ReplaceHook", {
        url: "https://example.com/alchemy/webhook-replace",
        events: ["deployment.created"],
      }),
    );
    expect(noop.webhookId).toEqual(first.webhookId);
    expect(noop.secret).toEqual(first.secret);

    // Changing the event list must replace (no PATCH on Vercel webhooks):
    // the engine creates the successor first, then deletes the old one.
    const second = yield* stack.deploy(
      Vercel.Webhook("ReplaceHook", {
        url: "https://example.com/alchemy/webhook-replace",
        events: ["deployment.created", "deployment.succeeded"],
      }),
    );
    expect(second.webhookId).not.toEqual(first.webhookId);
    // A replacement mints a fresh signing secret.
    expect(second.secret).not.toEqual(first.secret);
    expect([...second.events].sort()).toEqual([
      "deployment.created",
      "deployment.succeeded",
    ]);

    // Old id gone, new id live (out-of-band via distilled).
    expect(yield* getHook(first.webhookId)).toBeUndefined();
    const live = yield* getHook(second.webhookId);
    expect(live).toBeDefined();
    expect([...live!.events].sort()).toEqual([
      "deployment.created",
      "deployment.succeeded",
    ]);

    yield* stack.destroy();
    expect(yield* getHook(second.webhookId)).toBeUndefined();
  }).pipe(logLevel),
);

test.provider(
  "destroy is idempotent when the webhook is already gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hook = yield* stack.deploy(
        Vercel.Webhook("OrphanHook", {
          url: "https://example.com/alchemy/webhook-orphan",
          events: ["project.created"],
        }),
      );

      // Delete out-of-band, then destroy: the provider must treat the typed
      // NotFound as success (delete is idempotent by doctrine).
      const team = yield* teamScope;
      yield* webhooks.deleteWebhook({ id: hook.webhookId, ...team });
      expect(yield* getHook(hook.webhookId)).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Ungated probe: pins the distilled patch that types the 404 on
// getWebhook/deleteWebhook (code "not_found", "Webhook not found.") as the
// NotFound tag — proves the typed union at near-zero cost, forever.
test.provider("missing webhook surfaces the typed NotFound tag", () =>
  Effect.gen(function* () {
    const team = yield* teamScope;

    const got = yield* Effect.result(
      webhooks.getWebhook({
        id: "account_hook_alchemy_missing_probe",
        ...team,
      }),
    );
    expect(Result.isFailure(got)).toBe(true);
    if (Result.isFailure(got)) {
      expect(got.failure._tag).toEqual("NotFound");
    }

    const deleted = yield* Effect.result(
      webhooks.deleteWebhook({
        id: "account_hook_alchemy_missing_probe",
        ...team,
      }),
    );
    expect(Result.isFailure(deleted)).toBe(true);
    if (Result.isFailure(deleted)) {
      expect(deleted.failure._tag).toEqual("NotFound");
    }
  }).pipe(logLevel),
);
