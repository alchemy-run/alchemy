import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Archil.providers() });

test.provider(
  "port token opens one port and is revoked on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (ttl?: string) =>
        Effect.gen(function* () {
          const sandbox = yield* Archil.Sandbox("Preview", { ports: [3000] });
          const token = yield* Archil.SandboxPortToken("Token", {
            sandbox: sandbox.sandboxId,
            port: 3000,
            ttl,
          });
          return { sandbox, token };
        });
      const { sandbox, token } = yield* stack.deploy(app());
      expect(token.port).toBe(3000);
      expect(token.hostname.length).toBeGreaterThan(0);
      const listed = yield* archil.listSandboxPortTokens({ sid: sandbox.sandboxId });
      expect((listed.data.tokens ?? []).map((t) => t.id)).toContain(token.tokenId);

      const replaced = yield* stack.deploy(app("1h"));
      expect(replaced.token.tokenId).not.toBe(token.tokenId);
      expect(Date.parse(replaced.token.expiresAt ?? "")).toBeGreaterThan(Date.now());

      yield* stack.destroy();
    }),
  { tags: ["provider:archil", "provider:archil:sandboxporttoken", "live"], timeout: 300_000 },
);
