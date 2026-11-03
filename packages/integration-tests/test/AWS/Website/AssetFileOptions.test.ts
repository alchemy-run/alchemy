import { getFileOptions } from "@alchemy.run/aws/Website/AssetDeployment";
import { describe, expect, it } from "@alchemy.run/test";

const cacheControlFor = (file: string, files: string) =>
  getFileOptions(file, [{ files, cacheControl: "matched" }], undefined).cacheControl;

const matches = (file: string, files: string) => cacheControlFor(file, files) === "matched";

describe("getFileOptions globs", { tags: ["unit", "provider:aws", "provider:aws:website"] }, () => {
  it("matches every file with **", () => {
    expect(matches("index.html", "**")).toBe(true);
    expect(matches("assets/js/app.js", "**")).toBe(true);
  });

  it("matches root and nested files with **/*.html", () => {
    expect(matches("index.html", "**/*.html")).toBe(true);
    expect(matches("docs/guide/index.html", "**/*.html")).toBe(true);
    expect(matches("index.htm", "**/*.html")).toBe(false);
    expect(matches("assets/app.html.js", "**/*.html")).toBe(false);
  });

  it("keeps * within one path segment", () => {
    expect(matches("style.css", "*.css")).toBe(true);
    expect(matches("assets/style.css", "*.css")).toBe(false);
    expect(matches("assets/style.css", "assets/*.css")).toBe(true);
    expect(matches("assets/nested/style.css", "assets/*.css")).toBe(false);
  });

  it("matches one character with ?", () => {
    expect(matches("file1.txt", "file?.txt")).toBe(true);
    expect(matches("file12.txt", "file?.txt")).toBe(false);
    expect(matches("file/.txt", "file?.txt")).toBe(false);
  });

  it("matches regex characters literally", () => {
    expect(matches("assets/app.(v1)[x].js", "assets/app.(v1)[x].js")).toBe(true);
    expect(matches("assets/appX(v1)[x].js", "assets/app.(v1)[x].js")).toBe(false);
    expect(matches("assets/app.v1x.js", "assets/app.(v1)[x].js")).toBe(false);
  });

  it("lets a later rule win and honors ignore", () => {
    const options = [
      { files: "**", cacheControl: "default" },
      { files: "**/*.html", ignore: "admin/**", cacheControl: "html" },
    ];
    expect(getFileOptions("index.html", options, undefined).cacheControl).toBe("html");
    expect(getFileOptions("admin/index.html", options, undefined).cacheControl).toBe("default");
    expect(getFileOptions("app.js", options, undefined).cacheControl).toBe("default");
  });
});
