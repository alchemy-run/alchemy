import { planEnvSync } from "@alchemy.run/convex/internal/env";
import { cliEnvironment, parseDeployedUrl, redactOutput } from "@alchemy.run/convex/internal/push";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const tags = ["unit", "provider:convex", "local"];

it.effect(
  "parseDeployedUrl reads the deployed origin, ignoring colour codes",
  () =>
    Effect.sync(() => {
      expect(
        parseDeployedUrl(
          "\u001b[32m✔\u001b[39m Deployed Convex functions to https://happy-otter-123.convex.cloud\n",
        ),
      ).toBe("https://happy-otter-123.convex.cloud");
    }),
  { tags },
);

it.effect(
  "parseDeployedUrl keeps a regional host and drops a trailing slash",
  () =>
    Effect.sync(() => {
      expect(
        parseDeployedUrl(
          "Deployed Convex functions to https://calm-cow-456.eu-west-1.convex.cloud",
        ),
      ).toBe("https://calm-cow-456.eu-west-1.convex.cloud");
      expect(parseDeployedUrl("Deployed Convex functions to https://convex.example.com/")).toBe(
        "https://convex.example.com",
      );
    }),
  { tags },
);

it.effect(
  "parseDeployedUrl is undefined when the CLI printed no deployed line",
  () =>
    Effect.sync(() => {
      expect(parseDeployedUrl("✖ Error: Unable to push")).toBeUndefined();
    }),
  { tags },
);

it.effect(
  "cliEnvironment drops every CONVEX_ variable and points home at the temp directory",
  () =>
    Effect.sync(() => {
      expect(
        cliEnvironment(
          {
            PATH: "/bin",
            CONVEX_DEPLOYMENT: "dev:x",
            convex_deploy_key: "k",
            HOME: "/Users/me",
            UNSET: undefined,
          },
          "/tmp/h",
        ),
      ).toEqual({
        PATH: "/bin",
        HOME: "/tmp/h",
        USERPROFILE: "/tmp/h",
        XDG_CONFIG_HOME: "/tmp/h",
      });
    }),
  { tags },
);

it.effect(
  "redactOutput removes secrets",
  () =>
    Effect.sync(() => {
      const text = redactOutput("line1\nkey prod:abc|eyJsecretsecret\n", [
        "prod:abc|eyJsecretsecret",
        "eyJsecretsecret",
      ]);
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("eyJsecret");
    }),
  { tags },
);

it.effect(
  "redactOutput ignores secrets shorter than 8 characters",
  () =>
    Effect.sync(() => {
      expect(redactOutput("deploy ok", ["ok"])).toBe("deploy ok");
    }),
  { tags },
);

it.effect(
  "redactOutput keeps the last 20 non-empty lines",
  () =>
    Effect.sync(() => {
      const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n\n");
      const tail = redactOutput(lines, []).split("\n");
      expect(tail).toHaveLength(20);
      expect(tail[0]).toBe("line 5");
      expect(tail[19]).toBe("line 24");
    }),
  { tags },
);

it.effect(
  "planEnvSync writes changes first, removes dropped names after, and can undo the writes",
  () =>
    Effect.sync(() => {
      const plan = planEnvSync(
        { A: "1", B: "old", GONE: "x", HAND: "h" },
        { A: "1", B: "new", C: "3" },
        ["A", "B", "GONE"],
      );
      expect(plan.before).toEqual([
        { name: "B", value: "new" },
        { name: "C", value: "3" },
      ]);
      expect(plan.after).toEqual([{ name: "GONE", value: null }]);
      expect(plan.restore).toEqual([
        { name: "B", value: "old" },
        { name: "C", value: null },
      ]);
      expect(plan.foreign).toEqual([]);
    }),
  { tags },
);

it.effect(
  "planEnvSync names a variable someone else set to another value",
  () =>
    Effect.sync(() => {
      expect(planEnvSync({ HAND: "theirs" }, { HAND: "ours" }, []).foreign).toEqual(["HAND"]);
    }),
  { tags },
);

it.effect(
  "planEnvSync treats the same value set by someone else as no conflict",
  () =>
    Effect.sync(() => {
      const plan = planEnvSync({ HAND: "same" }, { HAND: "same" }, []);
      expect(plan.foreign).toEqual([]);
      expect(plan.before).toEqual([]);
    }),
  { tags },
);

it.effect(
  "planEnvSync skips a managed name that is already gone",
  () =>
    Effect.sync(() => {
      const plan = planEnvSync({}, {}, ["GONE"]);
      expect(plan.before).toEqual([]);
      expect(plan.after).toEqual([]);
    }),
  { tags },
);
