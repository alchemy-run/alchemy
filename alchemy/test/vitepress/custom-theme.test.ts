import { describe, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import "../../src/test/bun";
import { CustomTheme } from "../../src/vitepress/custom-theme";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta);

describe("VitePress CustomTheme Resource", () => {
  test("create a basic custom theme", async (scope) => {
    // Create a temporary directory for the test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-test-"));
    const themeDir = path.join(tempDir, ".vitepress/theme");

    try {
      // Create a basic custom theme
      const theme = await CustomTheme(`${BRANCH_PREFIX}-custom-theme`, {
        outDir: themeDir,
        title: "Basic Documentation Theme",
        description: "A clean, minimal theme for documentation",
        prompt: "Create a clean documentation theme with a sidebar and navbar",
      });

      // Verify the theme result
      expect(theme.themePath).toBe(themeDir);
      expect(theme.files.length).toBeGreaterThanOrEqual(3); // At least index, Layout, and styles

      // Check for essential files
      const fileNames = theme.files.map((f) => path.basename(f.path));
      expect(fileNames).toContain("index.ts");
      expect(fileNames).toContain("Layout.vue");
      expect(fileNames).toContain("styles.css");

      // Verify file existence on disk
      for (const file of theme.files) {
        const fileExists = await fs
          .access(file.path)
          .then(() => true)
          .catch(() => false);
        expect(fileExists).toBe(true);

        // Verify file content
        const content = await fs.readFile(file.path, "utf-8");
        expect(content).toBeTruthy();
        expect(content.length).toBeGreaterThan(100);
      }

      // Check index.ts content
      const indexFile = theme.files.find(
        (f) => path.basename(f.path) === "index.ts",
      );
      expect(indexFile).toBeTruthy();
      expect(indexFile?.content).toContain("Layout");
      expect(indexFile?.content).toContain("export default");

      // Check Layout.vue content
      const layoutFile = theme.files.find(
        (f) => path.basename(f.path) === "Layout.vue",
      );
      expect(layoutFile).toBeTruthy();
      expect(layoutFile?.content).toContain("<script setup");
      expect(layoutFile?.content).toContain("<Content");
      expect(layoutFile?.content).toContain("useData");
    } finally {
      // Clean up resources
      await destroy(scope);

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("create a theme with custom components", async (scope) => {
    // Create a temporary directory for the test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-test-"));
    const themeDir = path.join(tempDir, ".vitepress/theme");

    try {
      // Create a theme with custom components
      const theme = await CustomTheme(`${BRANCH_PREFIX}-complex-theme`, {
        outDir: themeDir,
        title: "Blog Theme",
        description: "A theme for technical blogs",
        components: [
          {
            name: "PostList",
            description:
              "Component that displays a list of blog posts with pagination",
            features: ["thumbnail images", "post dates", "categories"],
          },
          {
            name: "TableOfContents",
            description:
              "Component that displays the current page's table of contents",
            features: ["sticky positioning", "active link highlighting"],
          },
        ],
        prompt:
          "Create a modern blog theme with post listings and article pages",
      });

      // Verify the theme result
      expect(theme.themePath).toBe(themeDir);
      expect(theme.files.length).toBeGreaterThanOrEqual(5); // index, Layout, styles, and 2 components

      // Check for component files
      const fileNames = theme.files.map((f) => path.basename(f.path));
      expect(fileNames).toContain("PostList.vue");
      expect(fileNames).toContain("TableOfContents.vue");

      // Check component content
      const postListFile = theme.files.find(
        (f) => path.basename(f.path) === "PostList.vue",
      );
      expect(postListFile).toBeTruthy();
      expect(postListFile?.content).toContain("<script setup");

      const tocFile = theme.files.find(
        (f) => path.basename(f.path) === "TableOfContents.vue",
      );
      expect(tocFile).toBeTruthy();
      expect(tocFile?.content).toContain("<script setup");
    } finally {
      // Clean up resources
      await destroy(scope);

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("create a theme with custom CSS variables", async (scope) => {
    // Create a temporary directory for the test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-test-"));
    const themeDir = path.join(tempDir, ".vitepress/theme");

    try {
      // Create a theme with custom CSS variables
      const theme = await CustomTheme(`${BRANCH_PREFIX}-branded-theme`, {
        outDir: themeDir,
        title: "Branded Docs",
        description: "A themed documentation site with custom branding",
        customCssVars: {
          "--vp-c-brand": "#3a70b0",
          "--vp-c-brand-light": "#5785bc",
        },
        prompt: "Create a documentation theme with custom branding",
      });

      // Verify the CSS contains the custom variables
      const stylesFile = theme.files.find(
        (f) => path.basename(f.path) === "styles.css",
      );
      expect(stylesFile).toBeTruthy();
      expect(stylesFile?.content).toContain("--vp-c-brand: #3a70b0");
      expect(stylesFile?.content).toContain("--vp-c-brand-light: #5785bc");
    } finally {
      // Clean up resources
      await destroy(scope);

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
