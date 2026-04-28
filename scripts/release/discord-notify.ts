#!/usr/bin/env bun
/**
 * Post a release announcement to Discord using markdown so the message
 * renders inline (rather than relying on GitHub's link unfurl, which
 * produces a tall, ugly embed).
 *
 * Reads DISCORD_WEBHOOK from the environment. Silently no-ops if unset.
 *
 * Usage: bun scripts/release/discord-notify.ts <tag> <release|beta|alpha|tag>
 */
import { $ } from "bun";
import { generate } from "changelogithub";

const REPO = "alchemy-run/alchemy-effect";
// Discord caps message content at 2000 chars; leave headroom for the
// header, the trailing footer link, and markdown formatting.
const MAX_BODY = 1500;

const tag = process.argv[2];
const channel = process.argv[3];
if (!tag || !channel) {
  console.error(
    "Usage: bun scripts/release/discord-notify.ts <tag> <channel>",
  );
  process.exit(1);
}

const webhook = process.env.DISCORD_WEBHOOK;
if (!webhook) {
  console.log("DISCORD_WEBHOOK not set, skipping Discord notification");
  process.exit(0);
}

const prev = await $`git describe --tags --abbrev=0 ${`${tag}^`}`
  .nothrow()
  .quiet();
const from = prev.exitCode === 0 ? prev.stdout.toString().trim() : undefined;

const { md } = await generate({
  from,
  to: tag,
  emoji: true,
  contributors: false,
  repo: REPO,
});

// changelogithub leads with `## <tag>` then the section list. Drop the
// outer heading (we render our own) and trim down to fit Discord's limit.
let body = md.replace(/^##[^\n]*\n+/, "").trim();
if (body.length > MAX_BODY) {
  body = `${body.slice(0, MAX_BODY).trimEnd()}\n\n_…truncated; see full notes below._`;
}

const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
// Wrap the link in <…> so Discord does NOT generate an unfurl embed.
const content = [
  `## ${tag} (${channel}) released`,
  "",
  body,
  "",
  `[Full release notes →](<${releaseUrl}>)`,
].join("\n");

const res = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
});

if (!res.ok) {
  console.error(
    `Discord webhook failed: ${res.status} ${await res.text()}`,
  );
  process.exit(1);
}
console.log(`Posted Discord release notification for ${tag}`);
