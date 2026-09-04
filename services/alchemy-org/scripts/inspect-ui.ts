/** Identify the empty-text card. */
import puppeteer from "puppeteer-core";

const URL =
  "https://alchemyorg-alchemyorgworker-despsvnekxycm74bhaoockwqbo.testing-2b2.workers.dev";

const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 2400 });
await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
await new Promise((resolve) => setTimeout(resolve, 3000));
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("aside button")];
  (
    buttons.find((b) => b.textContent?.includes("#121")) as HTMLElement
  )?.click();
});
await new Promise((resolve) => setTimeout(resolve, 4000));

const found = await page.evaluate(() =>
  [...document.querySelectorAll("div.overflow-hidden.rounded-md.border")]
    .filter((el) => (el.textContent ?? "").trim() === "")
    .map((el) => el.outerHTML.slice(0, 700)),
);
for (const html of found) console.log("---\n" + html);
await browser.close();
