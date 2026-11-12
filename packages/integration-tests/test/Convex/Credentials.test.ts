import { readEnvironment } from "@alchemy.run/convex/AuthProvider";
import { teamFromDetails } from "@alchemy.run/convex/Credentials";
import { expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

it.effect("reads CONVEX_ACCESS_TOKEN and trims it", () =>
  Effect.gen(function* () {
    const credentials = yield* readEnvironment.pipe(
      withEnv({ CONVEX_ACCESS_TOKEN: "  token-value\n" }),
    );
    expect(Redacted.value(credentials.accessToken)).toBe("token-value");
    expect(credentials.apiBaseUrl).toBe("https://api.convex.dev/v1");
  }),
);

it.effect("an empty token fails without naming a value", () =>
  Effect.gen(function* () {
    const error = yield* readEnvironment.pipe(Effect.flip, withEnv({ CONVEX_ACCESS_TOKEN: "   " }));
    expect(error.message).toContain("CONVEX_ACCESS_TOKEN");
  }),
);

it.effect("reads CONVEX_API_BASE_URL and CONVEX_TEAM_ID", () =>
  Effect.gen(function* () {
    const credentials = yield* readEnvironment.pipe(
      withEnv({
        CONVEX_ACCESS_TOKEN: "t",
        CONVEX_API_BASE_URL: "https://example.test/v1",
        CONVEX_TEAM_ID: "42",
      }),
    );
    expect(credentials.apiBaseUrl).toBe("https://example.test/v1");
    expect(credentials.teamId).toBe("42");
  }),
);

it.effect("a team token gives its team", () =>
  Effect.gen(function* () {
    const team = yield* teamFromDetails({ type: "teamToken", id: 1, teamId: 7 } as never);
    expect(team).toBe(7);
  }),
);

it.effect("a CONVEX_TEAM_ID that matches the token's team is accepted", () =>
  Effect.gen(function* () {
    const team = yield* teamFromDetails({ type: "teamToken", id: 1, teamId: 42 } as never, "42");
    expect(team).toBe(42);
  }),
);

it.effect("a CONVEX_TEAM_ID for another team fails with InvalidTeamId", () =>
  Effect.gen(function* () {
    const error = yield* teamFromDetails(
      { type: "teamToken", id: 1, teamId: 1 } as never,
      "42",
    ).pipe(Effect.flip);
    expect(error._tag).toBe("InvalidTeamId");
    expect(error.message).toContain("belongs to team 1");
  }),
);

it.effect("a non-numeric CONVEX_TEAM_ID fails with InvalidTeamId", () =>
  Effect.gen(function* () {
    const error = yield* teamFromDetails(
      { type: "teamToken", id: 1, teamId: 1 } as never,
      "my-team",
    ).pipe(Effect.flip);
    expect(error._tag).toBe("InvalidTeamId");
  }),
);

it.effect("a token with no team fails with TeamTokenRequired", () =>
  Effect.gen(function* () {
    const error = yield* teamFromDetails({ type: "projectToken", id: 1 } as never).pipe(
      Effect.flip,
    );
    expect(error._tag).toBe("TeamTokenRequired");
  }),
);
