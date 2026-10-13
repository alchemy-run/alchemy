import { expect, type Page, test } from "@playwright/test";

/** The terminal's visible text (it renders to a canvas, so read its buffer). */
const screen = (page: Page) =>
  page.getByTestId("terminal").evaluate((element) => {
    const term = (
      element as unknown as {
        xterm: {
          buffer: {
            active: {
              length: number;
              getLine(i: number): { translateToString(trim: boolean): string } | undefined;
            };
          };
        };
      }
    ).xterm;
    const lines: string[] = [];
    for (let i = 0; i < term.buffer.active.length; i++) {
      lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
});

test("the terminal toggles open at the bottom and runs commands in the session's workspace", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Toggle terminal" }).click();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();

  // The shell starts once the session's container is up.
  await expect.poll(() => screen(page), { timeout: 180_000 }).toMatch(/[$#] *$/m);
  await page.getByTestId("terminal").click();
  await page.keyboard.type("echo terminal-$((40 + 2)) && git remote get-url origin\n");
  await expect.poll(() => screen(page), { timeout: 30_000 }).toContain("terminal-42");
  await expect.poll(() => screen(page), { timeout: 30_000 }).toContain("alchemy-run/alchemy");

  // Toggling closes it; the shell keeps running and its output comes back.
  await page.keyboard.press("Control+`");
  await expect(page.getByTestId("terminal-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle terminal" }).click();
  await expect.poll(() => screen(page), { timeout: 30_000 }).toContain("terminal-42");
});
