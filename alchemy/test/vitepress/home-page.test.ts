import { describe, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import "../../src/test/bun";
import { HomePage } from "../../src/vitepress/home-page";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta);

describe("VitePress HomePage Resource", () => {
  test("create a homepage with prompt only", async (scope) => {
    // Create a temporary directory for the test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-test-"));

    try {
      // Create a simple homepage
      const homePage = await HomePage(`${BRANCH_PREFIX}-home-page`, {
        outDir: tempDir,
        title: "Test VitePress Site",
        prompt:
          "Create a homepage for a technical documentation site about JavaScript testing tools",
      });

      // Verify the resource
      expect(homePage.title).toBe("Test VitePress Site");
      expect(homePage.path).toBe(path.join(tempDir, "index.md"));
      expect(homePage.content).toBeTruthy();

      // Verify file exists
      const fileExists = await fs
        .access(homePage.path)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      // Verify file content
      const content = await fs.readFile(homePage.path, "utf-8");

      // Check required frontmatter
      expect(content).toContain("---");
      expect(content).toContain("layout: home");

      // Basic content checks
      expect(content).toBeTruthy();
      expect(content.length).toBeGreaterThan(100);
    } finally {
      // Clean up resources
      await destroy(scope);

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("create a homepage with hero and features", async (scope) => {
    // Create a temporary directory for the test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-test-"));

    try {
      // Create a homepage with hero and features
      const homePage = await HomePage(`${BRANCH_PREFIX}-home-page-full`, {
        outDir: tempDir,
        title: "Featured VitePress Site",
        prompt: "Create a homepage for a modern JavaScript framework",
        hero: {
          name: "TestJS",
          text: "A modern JavaScript testing framework",
          tagline: "Simple, fast, and powerful",
          actions: [
            { text: "Get Started", link: "/guide/", theme: "brand" },
            { text: "GitHub", link: "https://github.com/example/testjs" },
          ],
        },
        features: [
          {
            icon: "🚀",
            title: "Fast",
            details: "Blazing fast test execution",
          },
          {
            icon: "🔍",
            title: "Intuitive",
            details: "Easy to write and maintain tests",
          },
          {
            icon: "🧩",
            title: "Extensible",
            details: "Plugin system for custom extensions",
          },
        ],
      });

      // Verify the resource
      expect(homePage.title).toBe("Featured VitePress Site");
      expect(homePage.path).toBe(path.join(tempDir, "index.md"));
      expect(homePage.content).toBeTruthy();

      // Verify file content
      const content = await fs.readFile(homePage.path, "utf-8");

      // Check required frontmatter
      expect(content).toContain("---");
      expect(content).toContain("layout: home");

      // Check that the hero and features were incorporated
      expect(content).toContain("TestJS");
      expect(content).toContain("modern JavaScript testing framework");
      expect(content).toContain("Fast");
      expect(content).toContain("Intuitive");
      expect(content).toContain("Extensible");
    } finally {
      // Clean up resources
      await destroy(scope);

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("create a homepage with system prompt extension", async (scope) => {
    // Create a temporary directory for the test
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alchemy-test-"));

    try {
      // Create a homepage with a system prompt extension
      const homePage = await HomePage(`${BRANCH_PREFIX}-home-page-extended`, {
        outDir: tempDir,
        title: "Extended VitePress Site",
        prompt: "Create a homepage for a data visualization library",
        systemPromptExtension:
          "Make sure to emphasize performance metrics and include code examples in markdown content.",
      });

      // Verify the resource
      expect(homePage.title).toBe("Extended VitePress Site");

      // Verify file content
      const content = await fs.readFile(homePage.path, "utf-8");

      // Basic content checks
      expect(content).toBeTruthy();
      expect(content.length).toBeGreaterThan(100);
    } finally {
      // Clean up resources
      await destroy(scope);

      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
