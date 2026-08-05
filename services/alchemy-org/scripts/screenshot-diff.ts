import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 500)));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE:", m.text().slice(0, 300)));
await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 });
await page.goto("http://localhost:62469", { waitUntil: "networkidle2", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 3500));
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("aside button")];
  (buttons.find((b) => b.textContent?.includes("#141")) as HTMLElement)?.click();
});
await new Promise((r) => setTimeout(r, 4000));
// click the FIRST "Read diff" card's clickable row (cursor-pointer)
const clicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("main [class*=cursor-pointer]")];
  const row = rows.find((el) =>
    el.textContent?.includes("Read diff of PR #141"),
  ) as HTMLElement | undefined;
  row?.click();
  return row !== undefined;
});
await new Promise((r) => setTimeout(r, 3000));
// scroll the row to the top of its scroll container, then clip-shoot
const rect = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("main [class*=cursor-pointer]")];
  const row = rows.find(
    (el) =>
      el.textContent?.includes("Read diff of PR #141") &&
      (el as HTMLElement).getBoundingClientRect().height > 0,
  ) as HTMLElement | undefined;
  if (!row) return null;
  row.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
  const r = row.getBoundingClientRect();
  return { x: 0, y: Math.max(0, r.top - 8) };
});
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({
  path: "/tmp/review-diff.png",
  clip: { x: 200, y: rect?.y ?? 0, width: 1240, height: 1000 },
});
await browser.close();
console.log("clicked:", clicked);
