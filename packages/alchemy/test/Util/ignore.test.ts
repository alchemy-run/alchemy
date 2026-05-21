// Runs the upstream `node-ignore` v7.0.5 test fixtures (vendored verbatim
// in ./ignore-cases.ts) against our in-tree copy of the module, plus a few
// targeted "others" cases lifted from upstream test/others.test.js.
import { describe, expect, test } from "vitest";
import ignore, { isPathValid } from "@/Util/ignore";
import { iterateCases } from "./ignore-cases.ts";

describe("vendored ignore: upstream cases.js", () => {
  iterateCases(
    ({
      description,
      patterns,
      paths_object,
      paths,
      expected,
      scopes,
    }: {
      description: string;
      patterns: any;
      paths_object: Record<string, 0 | 1>;
      paths: string[];
      expected: string[];
      scopes: false | string[];
    }) => {
      const inScope = (scope: string) =>
        scopes === false || scopes.includes(scope);

      if (inScope("filter")) {
        test(`.filter():        ${description}`, () => {
          const ig = ignore();
          const result = ig.add(patterns).filter(paths);
          expect([...result].sort()).toEqual([...expected].sort());
        });
      }

      if (inScope("createFilter")) {
        test(`.createFilter():  ${description}`, () => {
          const result = paths.filter(ignore().add(patterns).createFilter());
          expect([...result].sort()).toEqual([...expected].sort());
        });
      }

      if (inScope("ignores")) {
        test(`.ignores(path):   ${description}`, () => {
          const ig = ignore().add(patterns);
          for (const p of Object.keys(paths_object)) {
            const shouldIgnore = !!paths_object[p];
            expect(ig.ignores(p), `path "${p}"`).toBe(shouldIgnore);
          }
        });
      }

      if (inScope("checkIgnore")) {
        test(`.checkIgnore():   ${description}`, () => {
          const ig = ignore().add(patterns);
          for (const p of Object.keys(paths_object)) {
            const shouldIgnore = !!paths_object[p];
            const { ignored } = ig.checkIgnore(p);
            expect(ignored, `path "${p}"`).toBe(shouldIgnore);
          }
        });
      }
    },
  );
});

describe("vendored ignore: others", () => {
  test(".add(<Ignore>) composes another instance", () => {
    const a = ignore().add([".abc/*", "!.abc/d/"]);
    const b = ignore().add(a).add("!.abc/e/");

    const paths = [".abc/a.js", ".abc/d/e.js", ".abc/e/e.js"];

    expect(a.filter(paths)).toEqual([".abc/d/e.js"]);
    expect(b.filter(paths)).toEqual([".abc/d/e.js", ".abc/e/e.js"]);
  });

  test("options.ignorecase respects case sensitivity", () => {
    const ig = ignore({ ignorecase: false });
    ig.add("*.[jJ][pP]g");
    expect(ig.ignores("a.jpg")).toBe(true);
    expect(ig.ignores("a.JPg")).toBe(true);
    expect(ig.ignores("a.JPG")).toBe(false);
  });

  test("internal cache respects ignorecase", () => {
    const rule = "*.[jJ][pP]g";

    const ig = ignore({ ignorecase: false });
    ig.add(rule);
    expect(ig.ignores("a.JPG")).toBe(false);

    const ig2 = ignore({ ignorecase: true });
    ig2.add(rule);
    expect(ig2.ignores("a.JPG")).toBe(true);
  });

  test("invalid paths throw by default", () => {
    const ig = ignore();
    expect(() => ig.ignores("")).toThrow(/path must not be empty/);
    expect(() => ig.ignores(false as any)).toThrow(/path must be a string/);
    expect(() => ig.ignores("/a")).toThrow(/path\.relative/);
  });

  test("isPathValid filters out non-relative paths", () => {
    const paths = [".", "./foo", "../foo", "/foo", false, "foo"];
    expect(paths.filter(isPathValid as any)).toEqual(["foo"]);
  });

  test("options.allowRelativePaths = true accepts ../foo", () => {
    const ig = ignore({ allowRelativePaths: true });
    ig.add("foo");
    expect(ig.ignores("../foo/bar.js")).toBe(true);
    expect(() => ignore().ignores("../foo/bar.js")).toThrow();
  });

  describe(".test() return shape", () => {
    const TEST_CASES: Array<[string, any, string, [boolean, boolean]]> = [
      ["no rule", null, "foo", [false, false]],
      ["has rule, no match", "bar", "foo", [false, false]],
      ["only negative", "!foo", "foo", [false, true]],
      ["ignored then unignored", ["foo", "!foo"], "foo", [false, true]],
      [
        "dir ignored then unignored -> not matched",
        ["foo", "!foo"],
        "foo/bar",
        [false, false],
      ],
      [
        "ignored by wildcard, then unignored",
        ["*.js", "!a/a.js"],
        "a/a.js",
        [false, true],
      ],
    ];

    for (const [d, patterns, path, [ignored, unignored]] of TEST_CASES) {
      test(d, () => {
        const ig = ignore();
        if (patterns) ig.add(patterns);
        const result = ig.test(path);
        expect(result.ignored).toBe(ignored);
        expect(result.unignored).toBe(unignored);
      });
    }
  });
});
