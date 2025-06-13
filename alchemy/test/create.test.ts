import { describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";

import "../src/test/vitest.ts";

describe("Create CLI", () => {
  test("CLI shows help message", () => {
    const helpOutput = execSync("bun ../../src/cli.ts --help", { 
      encoding: "utf-8",
      cwd: path.join(process.cwd(), "alchemy", "test")
    });
    
    expect(helpOutput).toContain("Usage: alchemy");
    expect(helpOutput).toContain("--name=<name>");
    expect(helpOutput).toContain("--template=<name>");
    expect(helpOutput).toContain("typescript");
    expect(helpOutput).toContain("vite");
    expect(helpOutput).toContain("astro");
    expect(helpOutput).toContain("react-router");
    expect(helpOutput).toContain("sveltekit");
  });

  test("CLI shows version", () => {
    const versionOutput = execSync("bun ../../src/cli.ts --version", {
      encoding: "utf-8", 
      cwd: path.join(process.cwd(), "alchemy", "test")
    });
    
    expect(versionOutput.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("CLI validates project name", () => {
    expect(() => {
      execSync("bun ../../src/cli.ts --name='invalid name' --template=typescript --yes", {
        encoding: "utf-8",
        cwd: path.join(process.cwd(), "alchemy", "test")
      });
    }).toThrow();
  });

  test("CLI validates template name", () => {
    expect(() => {
      execSync("bun ../../src/cli.ts --name=testproject --template=invalid-template --yes", {
        encoding: "utf-8",
        cwd: path.join(process.cwd(), "alchemy", "test")
      });
    }).toThrow();
  });
});