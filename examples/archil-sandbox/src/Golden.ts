import * as Archil from "@alchemy.run/archil";

/**
 * The sandbox every fork starts from, set up at deploy: the repository
 * cloned onto its disk.
 */
export const Golden = Archil.Sandbox("Golden", {
  run: [
    "git clone --depth 1 https://github.com/sindresorhus/is /work/is",
    "git clone --depth 1 https://github.com/sindresorhus/slugify /work/slugify",
  ],
});
