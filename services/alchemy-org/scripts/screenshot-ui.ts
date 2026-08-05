/** Screenshot the review thread with the diff card expanded. */
import puppeteer from "puppeteer-core";

const URL = process.argv[2] ?? "http://localhost:62469";
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3500));
// open PR #141's thread
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("aside button")];
  (buttons.find((b) => b.textContent?.includes("#141")) as HTMLElement)?.click();
});
await new Promise((r) => setTimeout(r, 4000));
// expand the first "Read diff" tool card
await page.evaluate(() => {
  const cards = [...document.querySelectorAll("main [role=button], main button")];
  const diff = cards.find((c) => c.textContent?.includes("Read diff"));
  (diff as HTMLElement)?.click();
});
await new Promise((r) => setTimeout(r, 2500));
// scroll the conversation to the diff card
await page.evaluate(() => {
  const el = [...document.querySelectorAll("main *")].find((n) =>
    n.textContent?.includes("Read diff"),
  );
  el?.scrollIntoView({ block: "start" });
});
await new Promise((r) => setTimeout(r, 1000));
await page.screenshot({ path: process.argv[3] ?? "/tmp/review-ui.png" });
await browser.close();
console.log("saved");
