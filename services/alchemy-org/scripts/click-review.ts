import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto("http://localhost:51216", { waitUntil: "networkidle2", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3000));
// click PR #143 (no thread yet) — should flip to "reviewing…" and then select
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("aside button")];
  (buttons.find((b) => b.textContent?.includes("#143")) as HTMLElement)?.click();
});
await new Promise((r) => setTimeout(r, 15_000));
const state = await page.evaluate(() => ({
  header: document.querySelector("main .font-mono")?.textContent,
  row: [...document.querySelectorAll("aside button")]
    .find((b) => b.textContent?.includes("#143"))
    ?.textContent?.slice(0, 80),
}));
console.log(JSON.stringify(state));
await page.screenshot({ path: "/tmp/click-review.png" });
await browser.close();
