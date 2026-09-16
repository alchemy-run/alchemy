import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
await page.goto("http://localhost:62469", {
  waitUntil: "networkidle2",
  timeout: 60_000,
});
await new Promise((r) => setTimeout(r, 3500));
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("aside button")];
  (
    buttons.find((b) => b.textContent?.includes("#141")) as HTMLElement
  )?.click();
});
await new Promise((r) => setTimeout(r, 4000));
const info = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll("[data-streamdown]")].map((el) =>
    el.getAttribute("data-streamdown"),
  );
  const shadow = [...document.querySelectorAll("main *")].filter(
    (el) => el.shadowRoot,
  ).length;
  const errors: string[] = [];
  return { streamdownAttrs: [...new Set(blocks)], shadowHosts: shadow };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
