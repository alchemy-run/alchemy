import * as Boat from "@alchemy.run/boat";

/**
 * The snapshot every sandbox starts from, built at deploy: the repository
 * cloned and the tools installed, saved as a snapshot.
 */
export const Golden = Boat.Snapshot("Golden", {
  run: ["git clone --depth 1 https://github.com/sindresorhus/is ~/repo", "npm install -g pnpm"],
});
