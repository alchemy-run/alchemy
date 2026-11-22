import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/e2b/api_keys";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as secrets from "@distilled.cloud/e2b/secrets";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { BindingAgent, ProbeWebhook, RotatedSecret } from "./fixtures/resources.ts";
import E2BWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(E2B.providers(), Cloudflare.providers());
const { test } = Test.make({ providers });

/** Letters and digits only, lowercased: how a stack name survives inside a physical name. */
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The ids of the API keys a stack owns. Generated names start with the stack
 * name, and the stack's only API key is its host's minted one; the name is
 * truncated to 64 characters, so match on a prefix.
 */
const stackKeyIds = (stackName: string) =>
  apiKeys
    .listApiKeys({})
    .pipe(
      Effect.map(
        (all) =>
          new Set(
            all
              .filter((key) => squash(key.name).startsWith(squash(stackName).slice(0, 24)))
              .map((key) => key.id),
          ),
      ),
    );

test.provider(
  "sandboxes and secrets a binding creates carry the stack, stage and host as metadata",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* stackKeyIds(stack.name);
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* BindingAgent;
          yield* RotatedSecret;
          yield* ProbeWebhook;
          const worker = yield* E2BWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const name = `alchemy-${Test.defaultStage()}-tagged`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      // A fresh workers.dev URL answers 404 until it propagates.
      const client = HttpClient.filterStatus(
        yield* HttpClient.HttpClient,
        (status) => status !== 404,
      );
      const res = yield* client
        .get(`${url}/tagged?name=${name}`)
        .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
      const created = (yield* res.json) as { sandboxId: string; secretId: string };
      expect(res.status).toBe(200);

      // Delete what the Worker created before the stack goes: destroying it
      // leaves runtime objects alone, and the template can't be deleted
      // while the sandbox runs on it.
      const owner = {
        "alchemy::stack": stack.name,
        "alchemy::stage": Test.defaultStage(),
        "alchemy::id": "E2BWorker",
      };
      yield* Effect.gen(function* () {
        // Out of band: the user's metadata merges under the owner's tags,
        // and can't replace them.
        const sandbox = yield* sandboxes.getSandbox({ sandboxID: created.sandboxId });
        expect(sandbox.metadata).toMatchObject({ ...owner, purpose: "tag-check" });
        const secret = yield* secrets.getSecret({ secretID: created.secretId });
        expect(secret.metadata).toMatchObject({ ...owner, purpose: "tag-check" });
        // E2B's own metadata filter finds the sandbox by those tags.
        const listed = yield* sandboxes.listSandboxes({
          metadata: new URLSearchParams(owner).toString(),
          state: ["running"],
        });
        expect(listed.items.map((s) => s.sandboxID)).toContain(created.sandboxId);
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              sandboxes.deleteSandbox({ sandboxID: created.sandboxId }).pipe(Effect.ignore),
              secrets.deleteSecret({ secretID: created.secretId }).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
      );

      // The Worker ran on its own minted key, not the deployer's credentials.
      const minted = [...(yield* stackKeyIds(stack.name))].filter((id) => !before.has(id));
      expect(minted.length).toBeGreaterThan(0);
      // E2B records a key's last use asynchronously.
      const usedAt = yield* apiKeys.listApiKeys({}).pipe(
        Effect.map((all) =>
          all.filter((key) => minted.includes(key.id)).map((key) => key.lastUsed ?? undefined),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (stamps) => stamps.some((stamp) => stamp !== undefined),
          times: 10,
        }),
      );
      expect(usedAt.some((stamp) => stamp !== undefined)).toBe(true);

      yield* stack.destroy();
      // Destroying the host revokes its key.
      const after = yield* stackKeyIds(stack.name);
      expect(minted.filter((id) => after.has(id))).toEqual([]);
    }),
  {
    tags: ["provider:e2b", "provider:e2b:runtime-tags", "provider:cloudflare", "live"],
    timeout: 600_000,
  },
);
