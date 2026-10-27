# entire-review-agent

An [Entire](https://entire.com) project whose repository only moves through server-side merges,
with a Claude Code reviewer that runs on every Change that is ready for review.

```sh
alchemy profile edit --add Entire   # device login
bun run deploy
bun run test                         # deploys, checks the forge through the API, destroys
bun run destroy
```

Push to `et/<project>/api` and open a Change; the reviewer's findings land on its trail. Give it a
model key in the repo's `secrets` (`api_key_anthropic`) before relying on its runs.
