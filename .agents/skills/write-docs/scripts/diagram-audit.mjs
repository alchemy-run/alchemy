#!/usr/bin/env node
// Measure every diagram in the built site: is its caption under the panel, how
// much blank margin does its SVG keep, and how much of the panel does it fill.
// Usage (from the repo root, after `pnpm --filter website build`):
//   node .agents/skills/write-docs/scripts/diagram-audit.mjs
// Serves website/dist on :4400, prints figures with a caption inside the panel,
// a margin over 30 viewBox units, or a fill under 0.8 of the panel width.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("website/dist");
// Playwright isn't a website dependency, so take the newest copy in the pnpm store.
const store = path.resolve("node_modules/.pnpm");
const pwDir = fs
  .readdirSync(store)
  .filter((d) => /^playwright@\d/.test(d))
  .sort()
  .pop();
if (!pwDir) throw new Error("playwright not found in node_modules/.pnpm; run pnpm install");
const { chromium } = await import(path.join(store, pwDir, "node_modules/playwright/index.mjs"));

const pages = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (
      f.name === "index.html" &&
      /class="(alc-fig|alc-dag|alc-resp) /.test(fs.readFileSync(p, "utf8"))
    )
      pages.push("/" + path.relative(root, path.dirname(p)) + "/");
  }
};
walk(root);

const server = spawn("python3", ["-m", "http.server", "4400"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1303, height: 1300 } });
const problems = [];
let figures = 0;
const queue = [...pages];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    const page = await ctx.newPage();
    while (queue.length) {
      const p = queue.shift();
      await page.goto("http://localhost:4400" + p.replace(/^\/\.\//, "/"), { waitUntil: "load" });
      const recs = await page.evaluate(() =>
        [...document.querySelectorAll("figure.alc-fig, figure.alc-dag, figure.alc-resp")].map(
          (fig, i) => {
            const panel = fig.firstElementChild;
            const cs = getComputedStyle(panel);
            const inner =
              panel.getBoundingClientRect().width -
              parseFloat(cs.paddingLeft) -
              parseFloat(cs.paddingRight);
            const cap = fig.querySelector("figcaption");
            const r = {
              i,
              wrapped: /__panel/.test(panel.className),
              captionInside: cap ? cap.parentElement !== fig : false,
            };
            const svg = panel.querySelector(":scope > svg");
            if (svg) {
              const vb = svg.viewBox.baseVal,
                b = svg.getBBox();
              r.margin = Math.round(
                Math.max(
                  b.x - vb.x,
                  vb.x + vb.width - b.x - b.width,
                  b.y - vb.y,
                  vb.y + vb.height - b.y - b.height,
                ),
              );
              r.fill = +(svg.getBoundingClientRect().width / inner).toFixed(2);
              r.scale = +(svg.getBoundingClientRect().width / vb.width).toFixed(2);
            } else
              r.fill = +(panel.firstElementChild.getBoundingClientRect().width / inner).toFixed(2);
            return r;
          },
        ),
      );
      for (const r of recs) {
        figures++;
        const why = [
          !r.wrapped && "no __panel wrapper",
          r.captionInside && "caption inside the panel",
          r.margin > 30 && `blank margin ${r.margin}`,
          r.fill < 0.8 && `fills ${r.fill} of the panel`,
          r.scale < 0.7 && `drawn at ${r.scale}x, text too small`,
        ].filter(Boolean);
        if (why.length) problems.push(`${p} #${r.i}: ${why.join(", ")}`);
      }
    }
  }),
);
await browser.close();
server.kill();
console.log(`${figures} diagrams on ${pages.length} pages, ${problems.length} to look at`);
for (const line of problems.sort()) console.log("  " + line);
