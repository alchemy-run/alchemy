import { describe, expect, test } from "@alchemy.run/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  formatDeclaredPropertyYaml,
  formatDriftPropertyYaml,
  formatYamlLines,
} from "@/Cli/PropertyDiff.ts";
import * as Output from "@/Output.ts";

describe("YAML property display", { tags: ["unit", "local"] }, () => {
  test("preserves nested create properties", () => {
    expect(
      formatDeclaredPropertyYaml({}, { config: { ports: [80, 443], region: "iad" } }, "create")
        ?.lines,
    ).toEqual([
      "properties:",
      "  config:",
      "    ports:",
      "      - 80",
      "      - 443",
      "    region: iad",
    ]);
  });

  test("shows contextual git-style YAML for updates", () => {
    expect(
      formatDeclaredPropertyYaml(
        { id: "same", config: { enabled: true, retries: 2 } },
        { id: "same", config: { enabled: true, retries: 3 } },
        "update",
      )?.lines,
    ).toEqual([
      "properties:",
      "  config:",
      "    enabled: true",
      "-     retries: 2",
      "+     retries: 3",
      "  id: same",
    ]);
  });

  test("does not invent property changes", () => {
    expect(
      formatDeclaredPropertyYaml({ name: "same" }, { name: "same" }, "replace"),
    ).toBeUndefined();
  });

  test("shows only changed drift attributes", () => {
    expect(
      formatDriftPropertyYaml(
        { id: "same", config: { enabled: true, retries: 2 } },
        { id: "same", config: { enabled: true, retries: 5 } },
      ).lines,
    ).toEqual(["config:", "  enabled: true", "-   retries: 2", "+   retries: 5", "id: same"]);
  });

  test("identifies resources missing from the cloud", () => {
    expect(formatDriftPropertyYaml({ id: "expected" }, undefined, true).lines).toEqual([
      "- id: expected",
      "+ (missing)",
    ]);
  });

  test("never evaluates or reveals deferred and secret values", () => {
    let evaluated = false;
    const lines = formatYamlLines({
      output: Output.fromEffect(
        Effect.sync(() => {
          evaluated = true;
          return "resolved";
        }),
      ),
      secret: Redacted.make("super-secret"),
      task: Effect.sync(() => "computed"),
    }).join("\n");
    expect(evaluated).toBe(false);
    expect(lines).toContain("output: (known after apply)");
    expect(lines).toContain("secret: (redacted)");
    expect(lines).toContain("task: (computed)");
    expect(lines).not.toContain("super-secret");
    expect(lines).not.toContain("resolved");
  });

  test("shows a secret change without exposing either value", () => {
    const lines = formatDeclaredPropertyYaml(
      { token: Redacted.make("old-secret") },
      { token: Redacted.make("new-secret") },
      "update",
    )?.lines.join("\n");
    expect(lines).toContain("properties:\n  token: (redacted)");
    expect(lines).not.toContain("old-secret");
    expect(lines).not.toContain("new-secret");
  });

  for (const action of ["update", "replace"] as const) {
    test(`hides previous plaintext when a property becomes secret during ${action}`, () => {
      const oldProps = Object.freeze({
        env: Object.freeze({ API_KEY: "legacy-secret", PUBLIC: "visible", REMOVED: "removed" }),
      });
      const newProps = Object.freeze({
        env: Object.freeze({ API_KEY: Redacted.make("legacy-secret"), PUBLIC: "visible" }),
      });
      const lines = formatDeclaredPropertyYaml(oldProps, newProps, action)?.lines.join("\n");

      expect(lines).toContain("API_KEY: (redacted)");
      expect(lines).not.toContain("legacy-secret");
      expect(lines).toContain("PUBLIC: visible");
      expect(lines).toContain("-     REMOVED: removed");
      expect(oldProps.env.API_KEY).toBe("legacy-secret");
      expect(Redacted.value(newProps.env.API_KEY)).toBe("legacy-secret");
    });
  }

  test("hides entire previous objects and arrays when their parent becomes secret", () => {
    const lines = formatDeclaredPropertyYaml(
      { settings: { password: "legacy-object-secret" }, tokens: ["legacy-array-secret"] },
      {
        settings: Redacted.make({ password: "new-object-secret" }),
        tokens: Redacted.make(["new-array-secret"]),
      },
      "update",
    )?.lines;

    expect(lines).toEqual([
      "properties:",
      "-   settings: (hidden)",
      "+   settings: (redacted)",
      "-   tokens: (hidden)",
      "+   tokens: (redacted)",
    ]);
  });

  test("hides previous secret array entries by index and preserves removed entries", () => {
    const lines = formatDeclaredPropertyYaml(
      {
        entries: [{ token: "legacy-nested-secret", label: "visible" }, "legacy-secret", "removed"],
      },
      {
        entries: [
          { token: Redacted.make("new-nested-secret"), label: "visible" },
          Redacted.make("new-secret"),
        ],
      },
      "update",
    )?.lines.join("\n");

    expect(lines).not.toContain("legacy-nested-secret");
    expect(lines).not.toContain("legacy-secret");
    expect(lines).not.toContain("new-nested-secret");
    expect(lines).not.toContain("new-secret");
    expect(lines).toContain("token: (redacted)");
    expect(lines).toContain("label: visible");
    expect(lines).toContain("-     - removed");
  });

  test("applies different secret masks to shared objects at different paths", () => {
    const shared = { token: "shared-value" };
    const lines = formatDeclaredPropertyYaml(
      { private: shared, public: shared },
      { private: { token: Redacted.make("new-secret") }, public: { token: "changed-public" } },
      "update",
    )?.lines;

    expect(lines).toEqual([
      "properties:",
      "  private:",
      "-     token: (hidden)",
      "+     token: (redacted)",
      "  public:",
      "-     token: shared-value",
      "+     token: changed-public",
    ]);
  });

  test("handles cycles while hiding previous plaintext", () => {
    const oldProps: Record<string, unknown> = { token: "legacy-cyclic-secret" };
    oldProps.self = oldProps;
    const newProps: Record<string, unknown> = { token: Redacted.make("new-secret") };
    newProps.self = newProps;
    const lines = formatDeclaredPropertyYaml(oldProps, newProps, "update")?.lines.join("\n");

    expect(lines).toContain("self: (circular)");
    expect(lines).toContain("token: (redacted)");
    expect(lines).not.toContain("legacy-cyclic-secret");
    expect(lines).not.toContain("new-secret");
  });

  test("does not evaluate deferred desired properties while hiding previous plaintext", () => {
    let evaluated = false;
    const deferred = Effect.sync(() => {
      evaluated = true;
      return "resolved";
    });
    const lines = formatDeclaredPropertyYaml(
      { token: "legacy-secret", task: "old-task" },
      { token: Redacted.make("new-secret"), task: deferred, output: Output.fromEffect(deferred) },
      "update",
    )?.lines.join("\n");

    expect(evaluated).toBe(false);
    expect(lines).toContain("token: (redacted)");
    expect(lines).toContain("task: (computed)");
    expect(lines).toContain("output: (known after apply)");
    expect(lines).not.toContain("legacy-secret");
    expect(lines).not.toContain("new-secret");
    expect(lines).not.toContain("resolved");
  });

  test("hides previous plaintext behind a value the plan can't see into yet", () => {
    // A plain value moving onto a generated secret: the plan holds an Output
    // or an Effect there, which may resolve to a Redacted.
    const lines = formatDeclaredPropertyYaml(
      { env: { FROM_OUTPUT: "legacy-output", FROM_EFFECT: "legacy-effect" } },
      {
        env: {
          FROM_OUTPUT: Output.fromEffect(Effect.succeed(Redacted.make("new"))),
          FROM_EFFECT: Effect.succeed(Redacted.make("new")),
        },
      },
      "update",
    )?.lines.join("\n");

    expect(lines).toContain("FROM_OUTPUT: (hidden)");
    expect(lines).toContain("FROM_EFFECT: (hidden)");
    expect(lines).not.toContain("legacy-");
  });

  test("keeps unchanged opaque leaves as context while another prop changes", () => {
    const timeout = Duration.seconds(5);
    const at = new Date(0);
    const lines = formatDeclaredPropertyYaml(
      { name: "a", timeout, at },
      { name: "b", timeout, at },
      "update",
    )?.lines;

    expect(lines).toEqual([
      "properties:",
      "  at: (opaque)",
      "-   name: a",
      "+   name: b",
      "  timeout: (opaque)",
    ]);
  });

  test("hides a previous plain value that became data holding a secret", () => {
    const lines = formatDeclaredPropertyYaml(
      { auth: "legacy-token" },
      { auth: { token: Redacted.make("legacy-token") } },
      "update",
    )?.lines.join("\n");

    expect(lines).toContain("auth: (hidden)");
    expect(lines).not.toContain("legacy-token");
  });

  test("hides a previous array or record whose shape changed around a secret", () => {
    const lines = formatDeclaredPropertyYaml(
      { list: ["legacy-list"], record: { token: "legacy-record" } },
      { list: { token: Redacted.make("new") }, record: [Redacted.make("new")] },
      "update",
    )?.lines.join("\n");

    expect(lines).toContain("list: (hidden)");
    expect(lines).toContain("record: (hidden)");
    expect(lines).not.toContain("legacy-");
  });

  test("handles bigint and cycles", () => {
    const value: Record<string, unknown> = { size: 2n };
    value.self = value;
    expect(formatYamlLines(value)).toEqual(["self: (circular)", "size: 2n"]);
  });
});
