import { defineScene, edit } from "../capture/scene.ts";

export default defineScene({
  title: "An Effectful Worker with an API",
  chapter: "01-api",
  notes: "Chapter 1: an Effectful Worker serving a typed HttpApi.",
  async run(s) {
    await s.sync({
      except: [
        "src/Link.ts",
        "src/ShortyApi.ts",
        "src/Api.ts",
        "alchemy.run.ts",
        "web/src/client.ts",
        "web/src/main.tsx",
      ],
    });

    // src/Link.ts: the domain.
    const link = await s.chapterLines("src/Link.ts");
    await s.editor.patch(
      "src/Link.ts",
      "A Link is a Schema",
      edit.set(link(1, 8)),
      "The data type is an Effect Schema: one definition gives us the TypeScript type, validation, and JSON encoding.",
    );
    await s.editor.patch(
      "src/Link.ts",
      "A typed LinkNotFound error",
      edit.append(`\n${link(10, 15)}`),
      "Errors are values too. httpApiStatus: 404 means this error travels over HTTP as a typed 404 and comes back out as the same tagged error on the client.",
    );
    await s.editor.patch("src/Link.ts", "Short, URL-safe codes", edit.append(`\n${link(17, 21)}`));

    // src/ShortyApi.ts: the contract.
    const api = await s.chapterLines("src/ShortyApi.ts");
    await s.editor.patch("src/ShortyApi.ts", "Import HttpApi", edit.set(api(1, 5)));
    await s.editor.patch(
      "src/ShortyApi.ts",
      "An endpoint to create a link",
      edit.append(`\n${api(7, 12)}  ) {}\n`),
      "An HttpApi group: each endpoint declares its method, path, payload, success and error schemas.",
    );
    await s.editor.patch(
      "src/ShortyApi.ts",
      "List and get, with a typed 404",
      edit.replace("  ) {}\n", api(13, 21)),
    );
    await s.editor.patch(
      "src/ShortyApi.ts",
      "One value for server, client and tests",
      edit.append(`\n${api(23, 24)}`),
      "ShortyApi is a plain value. The Worker implements it, the dashboard derives a client from it, and the tests will use that same client.",
    );

    // src/Api.ts: the Worker.
    const worker = await s.chapterLines("src/Api.ts");
    await s.editor.patch("src/Api.ts", "Import Cloudflare and Effect", edit.set(worker(1) + worker(3)));
    await s.editor.patch(
      "src/Api.ts",
      "Declare the Worker",
      edit.append(`\n${worker(10, 13)}${worker(42, 43)}`),
      "A Worker is a class. Its body is an Effect: this outer part is the construction phase. It runs at deploy time, to discover the Worker's infrastructure, and at cold start.",
    );
    await s.editor.patch(
      "src/Api.ts",
      "Construction phase: an in-memory store",
      edit.all(
        edit.after('import * as Effect from "effect/Effect";\n', 'import type { Link } from "./Link.ts";\n'),
        edit.after(worker(13), worker(14, 15)),
      ),
      "A Map that lives in this isolate. It's deliberately naive: a deploy or a second isolate loses it. Chapter 2 fixes that.",
    );
    await s.editor.patch(
      "src/Api.ts",
      "Handle create",
      edit.all(
        edit.after('import * as Effect from "effect/Effect";\n', worker(6)),
        edit.replace('import type { Link } from "./Link.ts";\n', `import { newCode, type Link } from "./Link.ts";\n${worker(8)}`),
        edit.after(worker(15), worker(16, 25) + worker(31)),
      ),
      "HttpApiBuilder.group implements the links group. The handler's payload is already decoded and typed from the schema.",
    );
    await s.editor.patch(
      "src/Api.ts",
      "Handle list and get",
      edit.all(
        edit.replace("import { newCode, type Link }", "import { LinkNotFound, newCode, type Link }"),
        edit.after(worker(24, 25), worker(26, 30)),
      ),
      "get fails with LinkNotFound: the compiler checks it's one of the endpoint's declared errors.",
    );
    await s.editor.patch(
      "src/Api.ts",
      "Runtime phase: serve the API from fetch",
      edit.all(
        edit.after(worker(1), worker(2)),
        edit.before(worker(6), worker(4, 5)),
        edit.before(worker(42, 43), worker(32, 41)),
      ),
      "The Worker returns fetch: the runtime phase, run per request. It's the HttpApi turned into an HTTP handler, with CORS for the dashboard.",
    );

    // alchemy.run.ts: add the Worker to the Stack.
    await s.editor.patch(
      "alchemy.run.ts",
      "Add the Api to the Stack",
      edit.all(
        edit.after('import * as Effect from "effect/Effect";\n', 'import Api from "./src/Api.ts";\n'),
        edit.before("    const web = yield*", "    const api = yield* Api;\n"),
      ),
      "yield* Api adds the Worker to the Stack.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Output the API's URL",
      edit.replace("return { web: web.url };", "return { api: api.url.as<string>(), web: web.url };"),
      "The Stack's return value is its outputs: printed after every deploy, and handed to the tests.",
    );
    await s.editor.patch(
      "alchemy.run.ts",
      "Pass its URL to the website build",
      edit.after("      dev: { port: 5173 },\n", "      env: { VITE_API_URL: api.url.as<string>() },\n"),
      "api.url is an Output: a value known once the Worker exists. Alchemy orders the deploy so the website is built with it.",
    );

    // The dashboard.
    await s.editor.show("web/src/client.ts", "A typed client, derived from ShortyApi");
    await s.editor.show("web/src/main.tsx", "The dashboard lists and creates links");

    s.step("Start alchemy dev", "alchemy dev runs the whole stack locally and hot-reloads it on every save. It stays up for the rest of the talk.");
    await s.terminal(async (t) => {
      await t.type("dev", "alchemy dev");
      await t.waitDev();
      await t.sleep(1000);
    });

    s.step("Call the API");
    await s.terminal(async (t) => {
      await t.run(`curl --json '{"url":"https://effect.website"}' localhost:1337/links`);
      await t.run("curl localhost:1337/links");
    });

    s.step("The dashboard, calling the Worker");
    await s.browser.open("http://localhost:5173", { waitFor: /effect\.website/ });
    s.pause(1);

    s.step(
      "The architecture so far",
      "Two local Workers: Web knows Api's URL through an Output reference. No bindings yet.",
    );
    await s.diagram({ stage: `dev_${process.env.USER}`, nodes: ["Api", "Web"], edges: ["Web->Api"] });
    s.pause(1);
  },
});
