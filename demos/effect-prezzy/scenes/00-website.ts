import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "Deploy a website",
  chapter: "00-website",
  notes:
    "A plain Vite + React dashboard. One resource in alchemy.run.ts, Cloudflare.Website.Vite, and alchemy deploy builds it and ships it. Concepts: Stack, Resource, Output, stage, state.",
  async run(s) {
    await s.sync({ except: ["alchemy.run.ts"] });
    await s.editor.open("web/src/main.tsx");
    s.pause(1.5);
    await s.editor.show("alchemy.run.ts");
    s.pause(1);

    const url = await s.terminal(async (t) => {
      await t.type("deploy", "alchemy deploy");
      await t.waitFor("deploy", /Deploy\?/, { timeout: 120_000 });
      await t.sleep(1200);
      await t.key("deploy", "Enter");
      const text = await t.waitFor("deploy", /Stack deployed[\s\S]*❯\s*$/, { timeout: 300_000 });
      await t.sleep(1500);
      const found = text.match(/https:\/\/shorty-web-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0];
      if (!found) throw new Error("deployed URL not found in the terminal output");
      return found;
    });
    s.state.web = url;

    await s.diagram({ stage: `live_${process.env.USER}`, nodes: ["Web"] });
    s.pause(1);
    await s.browser.open(url, { waitFor: /Your links/ });
    s.pause(2);
  },
});
