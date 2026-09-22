import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Deploy a Vite website",
  notes:
    "The project is a plain Vite + React app. One resource in alchemy.run.ts turns it into a Cloudflare Website; alchemy deploy builds it and ships it.",
  async run(s) {
    await s.editor.open("src/main.tsx");
    s.pause(1.5);

    await s.editor.open("alchemy.run.ts");
    await s.editor.edit("alchemy.run.ts", (code) =>
      code.replace(
        "Effect.gen(function* () {}),",
        `Effect.gen(function* () {
    const website = yield* Cloudflare.Website.Vite("Website");

    return { url: website.url };
  }),`,
      ),
    );
    s.pause(1);

    const url = await s.terminal(async (t) => {
      await t.type("alchemy deploy");
      await t.enter();
      await t.wait(/Deploy\?/, { scope: "screen", timeout: "120s" });
      await t.sleep("1.5s");
      await t.enter();
      await t.wait(undefined, { timeout: "300s" });
      await t.expect(/Stack deployed/, { scope: "scrollback" });
      await t.sleep("2s");
      const url = t.scrollback().match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
      if (url === undefined) throw new Error("deployed URL not found in the terminal output");
      return url;
    });
    s.state.url = url;

    await s.browser.open(url, { waitFor: /Hello from Cloudflare/ });
    s.pause(2.5);
  },
});
