import { defineScene } from "../capture/scene.ts";

export default defineScene({
  title: "An Effectful Worker with an API",
  chapter: "01-api",
  notes:
    "The API is one HttpApi value: the Worker serves it, the dashboard and later the tests call it. The Worker's outer Effect is the construction phase (deploy time and cold start); fetch is the runtime phase. The Web site gets the API's URL as an Output. Start alchemy dev: it stays up for the rest of the talk.",
  async run(s) {
    await s.sync({ except: ["src/ShortyApi.ts", "src/Api.ts", "alchemy.run.ts", "web/src/client.ts"] });
    await s.editor.show("src/ShortyApi.ts");
    s.pause(1);
    await s.editor.show("src/Api.ts");
    s.pause(1);
    await s.editor.show("alchemy.run.ts");
    s.pause(0.5);
    await s.editor.show("web/src/client.ts");
    s.pause(1);

    await s.terminal(async (t) => {
      await t.type("dev", "alchemy dev");
      await t.waitDev();
      await t.sleep(1000);
      await t.run(`curl --json '{"url":"https://effect.website"}' localhost:1337/links`);
      await t.run("curl localhost:1337/links");
    });

    await s.browser.open("http://localhost:5173", { waitFor: /effect\.website/ });
    s.pause(1.5);
    await s.diagram({ stage: `dev_${process.env.USER}`, nodes: ["Api", "Web"], edges: ["Web->Api"] });
    s.pause(1);
  },
});
