import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { initialCwd } from "@/Util/Node.ts";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const command = Effect.fn(
  function* (args: string[]) {
    const child = yield* ChildProcess.make("terminal-browser", args);
    const [code, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0)
      return yield* Effect.fail(new Error(`Browser command failed: ${stderr}`));
    return stdout;
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
);

/** Opt-in real terminal-browser interactions against each deployed or native app. */
export const browserRoundtrip = Effect.fn(function* (
  url: string,
  slug: string,
) {
  if (process.env.NEON_WEBSITE_BROWSER !== "1") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const screenshots = path.join(
    initialCwd,
    ".alchemy",
    "log",
    "website-browser",
  );
  yield* fs.makeDirectory(screenshots, { recursive: true });
  const opened = yield* command([
    "new-tab",
    slug === "vocs" ? `${url}/counter` : url,
  ]);
  const tab = yield* Effect.try(
    () => JSON.parse(opened) as { key: string; openedTab: number },
  );
  const action = (...args: string[]) =>
    command([
      "action",
      "--browser",
      tab.key,
      "--tab",
      String(tab.openedTab),
      "--",
      ...args,
    ]);
  yield* Effect.addFinalizer(() =>
    action("eval", "location.href = 'about:blank'").pipe(
      Effect.andThen(
        command([
          "action",
          "--browser",
          tab.key,
          "--tab",
          String(tab.openedTab),
          "done",
        ]),
      ),
      Effect.ignore,
    ),
  );
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    yield* action("set", "viewport", String(width), String(height));
    yield* action("reload");
    const snapshot = yield* action("snapshot", "-i").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        times: 8,
        until: (text) => /button/.test(text),
      }),
    );
    const label = slug === "foldkit" ? "+" : "count: 0";
    expect(snapshot).toContain(label);
    yield* action(
      "find",
      "role",
      "button",
      "click",
      "--name",
      label,
      "--exact",
    );
    if (slug === "foldkit") {
      expect(yield* action("get", "text", "#count")).toContain("1");
      yield* action(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Reset",
        "--exact",
      );
      expect(yield* action("get", "text", "#count")).toContain("0");
    } else {
      expect(yield* action("snapshot", "-i")).toContain("count: 1");
      if (snapshot.includes("Load greeting")) {
        yield* action(
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Load greeting",
          "--exact",
        );
        expect(
          yield* action("get", "text", "body").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              times: 8,
              until: (text) => text.includes("Hello from"),
            }),
          ),
        ).toContain("Hello from");
      }
    }
    if (slug === "nextjs") {
      yield* action("fill", "#name", `Neon visitor ${width}`);
      yield* action(
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Submit name",
        "--exact",
      );
      expect(
        yield* action("get", "text", "body").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            times: 8,
            until: (text) => text.includes(`Submitted: Neon visitor ${width}`),
          }),
        ),
      ).toContain(`Submitted: Neon visitor ${width}`);
      yield* action("reload");
      expect(yield* action("get", "text", "body")).toContain(
        `Submitted: Neon visitor ${width}`,
      );
    }
    expect(
      yield* action(
        "eval",
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toContain("true");
    yield* action(
      "screenshot",
      path.join(
        screenshots,
        `${slug}-${url.startsWith("https:") ? "live" : "local"}-${width}.png`,
      ),
    );
    if (["astro", "nuxt", "sveltekit", "waku"].includes(slug)) {
      const route = slug === "astro" ? "/about/" : "/about";
      yield* action("click", `a[href="${route}"]`);
      expect(yield* action("get", "url")).toContain("/about");
      yield* action("reload");
      expect(yield* action("get", "text", "body")).toContain("prerendered");
      yield* action("back");
    }
  }
}, Effect.scoped);
