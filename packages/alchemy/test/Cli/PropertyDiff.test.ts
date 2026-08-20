import {
  diffDeclaredProperties,
  formatPropertyValue,
  type PropertyChange,
} from "@/Cli/PropertyDiff.ts";
import * as Output from "@/Output.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const concreteChanges = (changes: PropertyChange[]): PropertyChange[] =>
  changes;

describe("diffDeclaredProperties", () => {
  const cases = [
    {
      name: "scalar update",
      olds: { enabled: false },
      news: { enabled: true },
      expected: [{ kind: "update", path: "enabled" }],
    },
    {
      name: "property create and delete",
      olds: { removed: "old" },
      news: { added: "new" },
      expected: [
        { kind: "add", path: "added" },
        { kind: "remove", path: "removed" },
      ],
    },
    {
      name: "nested path",
      olds: { server: { ports: [80, 443] } },
      news: { server: { ports: [80, 8443] } },
      expected: [{ kind: "update", path: "server.ports[1]" }],
    },
  ] as const;

  for (const { name, olds, news, expected } of cases) {
    test(name, () => {
      expect(
        concreteChanges(diffDeclaredProperties(olds, news)).map(
          ({ kind, path }) => ({ kind, path }),
        ),
      ).toEqual(expected);
    });
  }

  test("identical props return no changes", () => {
    expect(
      diffDeclaredProperties(
        { nested: { value: 1 }, array: ["a", "b"] },
        { array: ["a", "b"], nested: { value: 1 } },
      ),
    ).toEqual([]);
  });

  test("Redacted values never expose their contents", () => {
    const changes = diffDeclaredProperties(
      { token: Redacted.make("old-secret") },
      { token: Redacted.make("new-secret") },
    );
    expect(changes).toEqual([
      {
        kind: "update",
        path: "token",
        before: { kind: "redacted" },
        after: { kind: "redacted" },
      },
    ]);
    const rendered = JSON.stringify(changes);
    expect(rendered).not.toContain("old-secret");
    expect(rendered).not.toContain("new-secret");
  });

  test("nested and unchanged Redacted values stay hidden", () => {
    const unchanged = Redacted.make("unchanged-secret");
    const changes = diffDeclaredProperties(
      { auth: { tokens: [Redacted.make("old-nested-secret"), unchanged] } },
      { auth: { tokens: [Redacted.make("new-nested-secret"), unchanged] } },
    );
    expect(changes).toEqual([
      {
        kind: "update",
        path: "auth.tokens[0]",
        before: { kind: "redacted" },
        after: { kind: "redacted" },
      },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(
      /nested-secret|unchanged-secret/,
    );
  });

  test("Outputs are not evaluated and are marked known after apply", () => {
    let evaluated = false;
    const output = Output.fromEffect(
      Effect.sync(() => {
        evaluated = true;
        return "resolved";
      }),
    );
    const changes = diffDeclaredProperties(
      { endpoint: "https://old.example.com" },
      { endpoint: output },
    );
    expect(evaluated).toBe(false);
    expect(changes).toEqual([
      {
        kind: "update",
        path: "endpoint",
        before: { kind: "literal", value: "https://old.example.com" },
        after: { kind: "known-after-apply" },
      },
    ]);
  });

  test("Effects are not executed and are marked computed", () => {
    let executed = false;
    const effect = Effect.sync(() => {
      executed = true;
      return "computed";
    });
    const changes = diffDeclaredProperties({}, { handler: effect });
    expect(executed).toBe(false);
    expect(changes).toEqual([
      {
        kind: "add",
        path: "handler",
        after: { kind: "computed" },
      },
    ]);
  });

  test("functions are not executed and are marked computed", () => {
    let executed = false;
    const fn = () => {
      executed = true;
      return "computed";
    };
    const changes = diffDeclaredProperties({}, { handler: fn });
    expect(executed).toBe(false);
    expect(changes).toEqual([
      {
        kind: "add",
        path: "handler",
        after: { kind: "computed" },
      },
    ]);
  });

  test("matches engine equality for omitted and undefined values", () => {
    const hole = Array(1);
    expect(diffDeclaredProperties({}, { value: undefined })).toEqual([]);
    expect(diffDeclaredProperties({ value: undefined }, {})).toEqual([]);
    expect(
      diffDeclaredProperties({ values: hole }, { values: [undefined] }),
    ).toEqual([]);
    expect(
      diffDeclaredProperties({ values: [] }, { values: [undefined] }),
    ).toEqual([
      {
        kind: "add",
        path: "values[0]",
        after: { kind: "undefined" },
      },
    ]);
  });

  test("keeps an added container whose only child is undefined", () => {
    expect(
      diffDeclaredProperties({}, { settings: { value: undefined } }),
    ).toEqual([
      {
        kind: "add",
        path: "settings",
        after: { kind: "collection", collection: "object" },
      },
    ]);
  });

  test("renders nullish and collection type changes explicitly", () => {
    expect(
      diffDeclaredProperties(
        { optional: null, shape: "literal" },
        { optional: undefined, shape: [] },
      ),
    ).toEqual([
      {
        kind: "update",
        path: "optional",
        before: { kind: "literal", value: null },
        after: { kind: "undefined" },
      },
      {
        kind: "update",
        path: "shape",
        before: { kind: "literal", value: "literal" },
        after: { kind: "collection", collection: "array" },
      },
    ]);
  });

  test("compares bigint leaves without throwing", () => {
    expect(diffDeclaredProperties({ size: 1n }, { size: 2n })).toEqual([
      {
        kind: "update",
        path: "size",
        before: { kind: "opaque" },
        after: { kind: "opaque" },
      },
    ]);
    expect(diffDeclaredProperties({ size: 1n }, { size: 1n })).toEqual([]);
  });

  test("documents array insertions as index changes", () => {
    expect(
      concreteChanges(
        diffDeclaredProperties(
          { regions: ["fra", "iad"] },
          { regions: ["lhr", "fra", "iad"] },
        ),
      ).map(({ kind, path }) => ({ kind, path })),
    ).toEqual([
      { kind: "update", path: "regions[0]" },
      { kind: "update", path: "regions[1]" },
      { kind: "add", path: "regions[2]" },
    ]);
  });

  test("sorts object paths deterministically", () => {
    const paths = concreteChanges(
      diffDeclaredProperties({}, { zebra: 1, alpha: 2, middle: 3 }),
    ).map((change) => change.path);
    expect(paths).toEqual(["alpha", "middle", "zebra"]);
  });

  test("returns every declared change without a count cap", () => {
    const news = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [
        `property${String(index).padStart(3, "0")}`,
        index,
      ]),
    );
    const changes = diffDeclaredProperties({}, news);
    expect(changes).toHaveLength(105);
    expect(changes[104].path).toBe("property104");
  });

  test("truncates long display values", () => {
    const [change] = diffDeclaredProperties(
      { value: "short" },
      { value: "abcdefgh" },
      { maxValueLength: 4 },
    );
    expect(change.kind).toBe("update");
    if (change.kind !== "update") return;
    expect(change.after).toEqual({
      kind: "literal",
      value: "abcd",
      truncated: true,
    });
    expect(formatPropertyValue(change.after!)).toBe('"abcd"…');
  });

  test("terminates on cyclic plain data", () => {
    const oldValue: Record<string, unknown> = { name: "old" };
    const newValue: Record<string, unknown> = { name: "new" };
    oldValue.self = oldValue;
    newValue.self = newValue;
    expect(
      concreteChanges(
        diffDeclaredProperties({ value: oldValue }, { value: newValue }),
      ).map((change) => change.path),
    ).toEqual(["value.name"]);
  });
});
