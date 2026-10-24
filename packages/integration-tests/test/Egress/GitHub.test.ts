import * as GitHub from "@alchemy.run/github";
import { describe, expect, it } from "@alchemy.run/test";
import type { EgressRequest } from "alchemy/Egress/Kind";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";

const configured = GitHub.Egress({
  token: Redacted.make("ghp_test"),
  repositories: [{ repository: "Alchemy-Run/Alchemy", contents: "read", issues: "write" }],
});

const run = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  effect.pipe(Effect.provide(RuntimeContext.phantom));

describe("GitHub.Egress (gateway kind)", { tags: ["unit", "local"] }, () => {
  it.effect("allows only the configured repositories", () =>
    Effect.gen(function* () {
      const egress = yield* configured;
      const allows = (request: EgressRequest) => Effect.result(run(egress.allows(request)));
      expect((yield* allows({}))._tag).toBe("Success");
      expect((yield* allows({ scope: { repository: "alchemy-run/alchemy" } }))._tag).toBe(
        "Success",
      );
      expect((yield* allows({ scope: { repository: "alchemy-run/alchemy", issue: 1 } }))._tag).toBe(
        "Success",
      );
      const other = yield* allows({ scope: { repository: "cli/cli" } });
      expect(other._tag === "Failure" && other.failure.message).toContain("cli/cli");
      expect((yield* allows({ scope: { repo: "alchemy-run/alchemy" } }))._tag).toBe("Failure");
      expect(
        (yield* allows({ scope: { repository: "alchemy-run/alchemy", issue: 1, pullRequest: 2 } }))
          ._tag,
      ).toBe("Failure");
      // A static token takes no subject.
      expect((yield* allows({ subject: "u_1" }))._tag).toBe("Failure");
    }),
  );

  it.effect("a per-subject token needs a subject", () =>
    Effect.gen(function* () {
      const egress = yield* GitHub.Egress({
        token: ({ subject }) => Effect.succeed(`token-${subject}`),
      });
      expect(egress.perSubject).toBe(true);
      expect((yield* Effect.result(run(egress.allows({}))))._tag).toBe("Failure");
      expect(
        (yield* Effect.result(
          run(egress.allows({ scope: { repository: "any/repo" }, subject: "u_1" })),
        ))._tag,
      ).toBe("Success");
      // The subject's token is what gets added.
      const handle = yield* run(egress.handler({ subject: "u_1" }));
      const decided = yield* handle(HttpClientRequest.get("https://api.github.com/user"));
      expect(HttpServerResponse.isHttpServerResponse(decided)).toBe(false);
      if (!HttpServerResponse.isHttpServerResponse(decided)) {
        expect(decided.headers.authorization).toBe("token token-u_1");
      }
    }),
  );

  it.effect("routes: whole hosts unless narrowed to a repository", () =>
    Effect.gen(function* () {
      const egress = yield* configured;
      expect(yield* run(egress.routes({}))).toEqual([
        { host: "github.com" },
        { host: "api.github.com" },
        { host: "uploads.github.com" },
      ]);
      expect(
        yield* run(egress.routes({ scope: { repository: "alchemy-run/alchemy", graphql: false } })),
      ).toEqual([
        { host: "github.com", paths: ["/alchemy-run/alchemy/**", "/alchemy-run/alchemy.git/**"] },
        { host: "api.github.com", paths: ["/repos/alchemy-run/alchemy/**"] },
        { host: "uploads.github.com", paths: ["/repos/alchemy-run/alchemy/**"] },
      ]);
    }),
  );

  it.effect("the handler applies the rules: reads pass with the token, writes are refused", () =>
    Effect.gen(function* () {
      const egress = yield* configured;
      const handle = yield* run(egress.handler({ scope: { repository: "alchemy-run/alchemy" } }));
      const read = yield* handle(
        HttpClientRequest.get("https://api.github.com/repos/alchemy-run/alchemy"),
      );
      expect(HttpServerResponse.isHttpServerResponse(read)).toBe(false);
      if (!HttpServerResponse.isHttpServerResponse(read)) {
        expect(read.headers.authorization).toBe("token ghp_test");
      }
      const write = yield* handle(
        HttpClientRequest.put("https://api.github.com/repos/alchemy-run/alchemy/contents/x"),
      );
      expect(HttpServerResponse.isHttpServerResponse(write) && write.status).toBe(403);
      const other = yield* handle(HttpClientRequest.get("https://api.github.com/repos/cli/cli"));
      expect(HttpServerResponse.isHttpServerResponse(other) && other.status).toBe(403);
    }),
  );
});
