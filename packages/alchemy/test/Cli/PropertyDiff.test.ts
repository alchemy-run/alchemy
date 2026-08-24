import {
  formatDeclaredPropertyYaml,
  formatYamlLines,
} from "@/Cli/PropertyDiff.ts";
import * as Output from "@/Output.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("YAML property display", () => {
  test("preserves nested create properties", () => {
    expect(
      formatDeclaredPropertyYaml(
        {},
        { config: { ports: [80, 443], region: "iad" } },
        "create",
      )?.lines,
    ).toEqual([
      "properties:",
      "  config:",
      "    ports:",
      "      - 80",
      "      - 443",
      "    region: iad",
    ]);
  });

  test("shows before and after YAML for updates", () => {
    expect(
      formatDeclaredPropertyYaml(
        { config: { retries: 2 } },
        { config: { retries: 3 } },
        "update",
      )?.lines,
    ).toEqual([
      "before:",
      "  config:",
      "    retries: 2",
      "after:",
      "  config:",
      "    retries: 3",
    ]);
  });

  test("does not invent property changes", () => {
    expect(
      formatDeclaredPropertyYaml({ name: "same" }, { name: "same" }, "replace"),
    ).toBeUndefined();
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
    expect(lines).toContain("before:\n  token: (redacted)");
    expect(lines).toContain("after:\n  token: (redacted)");
    expect(lines).not.toContain("old-secret");
    expect(lines).not.toContain("new-secret");
  });

  test("handles bigint and cycles", () => {
    const value: Record<string, unknown> = { size: 2n };
    value.self = value;
    expect(formatYamlLines(value)).toEqual(["self: (circular)", "size: 2n"]);
  });
});
