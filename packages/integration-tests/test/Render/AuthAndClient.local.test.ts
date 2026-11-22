import * as Render from "@alchemy.run/render";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as TestCore from "@alchemy.run/test/Core";
import { AuthProvidersLive, getAuthProvider } from "alchemy/Auth/AuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Provider from "alchemy/Provider";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

describe("Render Auth & Profiles", { tags: ["provider:render", "local"], timeout: 60_000 }, () => {
  const authLayer = Render.RenderAuth.pipe(Layer.provideMerge(AuthProvidersLive));
  const options = { providers: authLayer, state: inMemoryState() };

  it.effect("registers Render AuthProvider, configures stored profiles, and redacts details", () =>
    TestCore.toEffect(
      Effect.gen(function* () {
        const provider = yield* getAuthProvider<
          Render.RenderAuthConfig,
          Render.RenderResolvedCredentials
        >(Render.RENDER_AUTH_PROVIDER_NAME);

        expect(provider.environment?.map((entry) => entry.name)).toEqual([
          "RENDER_API_KEY",
          "RENDER_OWNER_ID",
          "RENDER_API_BASE_URL",
        ]);

        const stored = yield* provider.configureWith!("testing", {
          method: "stored",
          values: {
            apiKey: "rnd_profile_secret",
            ownerId: "tea-profile-owner",
            apiBaseUrl: "http://127.0.0.1:9999/v1/",
          },
        });
        const resolved = yield* provider.read("testing", Effect.succeed(stored));
        expect(Redacted.value(resolved.apiKey)).toBe("rnd_profile_secret");
        expect(resolved.ownerId).toBe("tea-profile-owner");
        expect(resolved.apiBaseUrl).toBe("http://127.0.0.1:9999/v1");

        const details = yield* provider.details("testing", Effect.succeed(stored));
        expect(JSON.stringify(details)).not.toContain("rnd_profile_secret");
      }).pipe(Effect.provide(Interaction.layerNonInteractive()), Effect.provide(authLayer)),
      options,
    ),
  );

  it.effect(
    "resolves CI credentials from RENDER_API_KEY / RENDER_TOKEN and fails loudly when missing",
    () =>
      TestCore.toEffect(
        Effect.gen(function* () {
          const provider = yield* getAuthProvider<
            Render.RenderAuthConfig,
            Render.RenderResolvedCredentials
          >(Render.RENDER_AUTH_PROVIDER_NAME);

          const resolved = yield* provider.readEnvironment!.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  RENDER_API_KEY: "rnd_env_secret",
                  RENDER_OWNER_ID: "tea-custom-owner",
                  RENDER_API_BASE_URL: "http://127.0.0.1:9999/v1/",
                }),
              ),
            ),
          );
          expect(Redacted.value(resolved.apiKey)).toBe("rnd_env_secret");
          expect(resolved.ownerId).toBe("tea-custom-owner");
          expect(resolved.apiBaseUrl).toBe("http://127.0.0.1:9999/v1");

          const fromAlt = yield* provider.readEnvironment!.pipe(
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ RENDER_TOKEN: "rnd_alt_secret" })),
            ),
          );
          expect(Redacted.value(fromAlt.apiKey)).toBe("rnd_alt_secret");
          expect(fromAlt.apiBaseUrl).toBe(Render.DEFAULT_API_BASE_URL);

          const missing = yield* provider.readEnvironment!.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            Effect.flip,
          );
          expect(missing._tag).toBe("AuthError");
        }).pipe(Effect.provide(authLayer)),
        options,
      ),
  );
});

describe(
  "Render Single-Owner Resolution",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({
      owners: [{ id: "tea-sole", name: "Sole Team", email: "sole@alchemy.test", type: "team" }],
    });
    const t = Test.make({ providers: fake.providersLayer() });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "auto-resolves single owner via GET /owners and fails on 0 or >1 owners",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          fake.owners = [
            { id: "tea-sole", name: "Sole Team", email: "sole@alchemy.test", type: "team" },
          ];
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Render.Project("AutoOwnerProj", { name: "auto-owner-proj" });
            }),
          );
          expect(created.ownerId).toBe("tea-sole");
          yield* stack.destroy();

          fake.owners = [
            { id: "tea-1", name: "Team One", email: "1@alchemy.test", type: "team" },
            { id: "tea-2", name: "Team Two", email: "2@alchemy.test", type: "team" },
          ];
          const multiErr = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Render.Project("AmbiguousOwnerProj", { name: "ambiguous-proj" });
              }),
            )
            .pipe(Effect.flip);
          expect(JSON.stringify(multiErr)).toContain("RenderOwnerResolutionError");

          fake.owners = [];
          const emptyErr = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Render.Project("NoOwnerProj", { name: "no-owner-proj" });
              }),
            )
            .pipe(Effect.flip);
          expect(JSON.stringify(emptyErr)).toContain("RenderOwnerResolutionError");

          fake.owners = [
            { id: "tea-sole", name: "Sole Team", email: "sole@alchemy.test", type: "team" },
          ];
          yield* stack.destroy();
          expect(fake.snapshotCounts().projects).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);

describe(
  "Render HTTP Retries & Cursor Pagination",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({ maxPageSize: 1 });
    const t = Test.make({ providers: fake.providersLayer() });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "retries 429 and 500 responses, fails fast on 403 Forbidden, and paginates cursor lists",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          fake.pushFault({
            method: "POST",
            path: "/webhooks",
            status: 429,
            remaining: 1,
            headers: { "Retry-After": "0" },
            body: { message: "rate limited" },
          });
          fake.pushFault({
            method: "POST",
            path: "/webhooks",
            status: 500,
            remaining: 1,
            body: { message: "transient upstream" },
          });

          const hooks = yield* stack.deploy(
            Effect.gen(function* () {
              const a = yield* Render.Webhook("HookPageA", {
                name: "page-a",
                url: "https://example.test/a",
              });
              const b = yield* Render.Webhook("HookPageB", {
                name: "page-b",
                url: "https://example.test/b",
              });
              const c = yield* Render.Webhook("HookPageC", {
                name: "page-c",
                url: "https://example.test/c",
              });
              return [a, b, c] as const;
            }),
          );
          expect(hooks.length).toBe(3);

          const postCalls = fake.calls.filter((c) => c.method === "POST" && c.path === "/webhooks");
          // 3 hooks + 2 transient injected faults = 5 POST attempts
          expect(postCalls.length).toBe(5);

          // Cursor-based list + lookup across 3 single-item pages
          const webhookProvider = yield* Provider.findProvider(Render.Webhook);
          const allListed = yield* webhookProvider.list!();
          expect(allListed.map((w) => w.name).sort()).toEqual(["page-a", "page-b", "page-c"]);

          const lookedUp = yield* webhookProvider.lookup!({ name: "page-c" });
          expect(lookedUp?.id).toBe(hooks[2].id);

          const listCalls = fake.calls.filter((c) => c.method === "GET" && c.path === "/webhooks");
          expect(listCalls.length).toBeGreaterThanOrEqual(3);

          // 403 Forbidden must surface loudly on delete and never be treated as NotFound.
          fake.pushFault({
            method: "DELETE",
            path: `/webhooks/${hooks[0].id}`,
            status: 403,
            remaining: 1,
            body: { message: "forbidden by policy" },
          });
          const deleteErr = yield* stack.destroy().pipe(Effect.flip);
          expect(JSON.stringify(deleteErr)).toContain("RenderForbiddenError");

          // Second destroy finishes cleanup cleanly now that the 403 fault has expired.
          yield* stack.destroy();
          expect(fake.snapshotCounts().webhooks).toBe(0);

          // Long-window 429 (e.g., hourly quota RateLimit-Reset: 1800) must fail fast in 1 attempt
          // without sleeping or retrying.
          const beforeLong429Calls = fake.calls.filter(
            (c) => c.method === "POST" && c.path === "/webhooks",
          ).length;
          fake.pushFault({
            method: "POST",
            path: "/webhooks",
            status: 429,
            remaining: 1,
            headers: { "RateLimit-Reset": "1800" },
            body: { message: "rate limit exceeded" },
          });
          const long429Err = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Render.Webhook("HookRateLimited", {
                  name: "hook-rate-limited",
                  url: "https://example.test/rate-limited",
                });
              }),
            )
            .pipe(Effect.flip);
          const afterLong429Calls = fake.calls.filter(
            (c) => c.method === "POST" && c.path === "/webhooks",
          ).length;
          expect(afterLong429Calls - beforeLong429Calls).toBe(1);
          const long429Text = JSON.stringify(long429Err);
          expect(long429Text).toContain("RenderRateLimitError");
          expect(long429Text).toContain("1800");
          yield* stack.destroy();
          expect(fake.snapshotCounts().webhooks).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
