import { describe, expect, it } from "vitest";
import { isDeployTarget } from "../../core/index.ts";
import { inlineTemplate, target } from "../azure.ts";
import { SERVER_ENTRY_FILE_NAME } from "../node.ts";

const template = '<!doctype html>\n<div id="root"><!--ssr-body--></div>\n';

describe("Octane azure target", () => {
  it("reuses the Node build under the azure platform", () => {
    const azure = target();
    expect(isDeployTarget(azure)).toBe(true);
    expect(azure.platform).toBe("azure");
    expect(azure.serverEntryFileName).toBe(SERVER_ENTRY_FILE_NAME);
    expect(azure.build).toBeTypeOf("function");
    expect(azure.finish).toBeTypeOf("function");
  });

  it("inlines the SSR template Octane's entry reads at load time", () => {
    const source = [
      "var __dirname = dirname(fileURLToPath(import.meta.url));",
      'var htmlTemplate = readFileSync(join(__dirname, "./index.html"), "utf-8");',
    ].join("\n");
    const inlined = inlineTemplate(source, template);
    expect(inlined).toBe(
      [
        "var __dirname = dirname(fileURLToPath(import.meta.url));",
        `var htmlTemplate = ${JSON.stringify(template)};`,
      ].join("\n"),
    );
  });

  it("inlines the minified read", () => {
    const source = "const t=readFileSync(join(__dirname,'./index.html'),'utf8');";
    expect(inlineTemplate(source, template)).toBe(`const t=${JSON.stringify(template)};`);
  });

  it("reports a source without the read", () => {
    expect(inlineTemplate("export const handler = () => {};", template)).toBeUndefined();
  });
});
