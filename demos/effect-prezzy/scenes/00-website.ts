import { defineScene, edit } from "../capture/scene.ts";

export default defineScene({
  title: "Deploy a website",
  chapter: "00-website",
  notes: "Chapter 0: declare a Stack with one Vite website and deploy it.",
  async run(s) {
    await s.sync({ except: ["alchemy.run.ts"] });

    s.step(
      "Start from a plain Vite + React app",
      "An ordinary Vite + React dashboard. Nothing Alchemy-specific in it yet.",
    );
    await s.editor.open("web/src/main.tsx");
    s.pause(1);

    const stack = await s.chapterLines("alchemy.run.ts");
    await s.editor.patch(
      "alchemy.run.ts",
      "Create alchemy.run.ts",
      edit.set(stack(1, 3)),
      "alchemy.run.ts is the whole infrastructure program. It's plain TypeScript: Alchemy, the Cloudflare provider, and Effect.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Declare the Stack",
      edit.append(`\n${stack(5, 11)}  }),\n);\n`),
      "A Stack has a name, the providers it can use, and where it keeps its state. Its body is an Effect: every resource is something we yield.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Add the Vite website as a resource",
      edit.after(stack(11), stack(12, 15)),
      "Cloudflare.Website.Vite builds the Vite app and serves it from a Cloudflare Worker. dev pins the port alchemy dev will use later.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Output the website's URL",
      edit.after(stack(15), stack(16, 17)),
      "Whatever the Stack returns is its output: printed after every deploy.",
    );

    s.step("Deploy it with alchemy deploy", "alchemy deploy plans the change, asks to confirm, then applies it.");
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

    s.step("One resource, deployed to Cloudflare", "The architecture: a single Worker serving the site, running in the cloud.");
    await s.diagram({ stage: `live_${process.env.USER}`, nodes: ["Web"] });
    s.pause(1);

    s.step("The website is live");
    await s.browser.open(url, { waitFor: /Your links/ });
    s.pause(1.5);
  },
});
