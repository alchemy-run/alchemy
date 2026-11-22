import type { AsyncJobEnv } from "./job-resources.ts";

/**
 * A plain job handler: no Effect, deployed by `job-resources.ts`. The
 * execution succeeds only when every `env` entry decodes as declared.
 */
export default {
  async run(env: AsyncJobEnv) {
    const problems = [
      env.GREETING === "hello" ? undefined : `GREETING is ${JSON.stringify(env.GREETING)}`,
      env.SECRET === "s3cret" ? undefined : `SECRET has ${String(env.SECRET).length} characters`,
      typeof env.CONTAINER?.containerName === "string" && env.CONTAINER.containerName.length > 0
        ? undefined
        : `CONTAINER is ${JSON.stringify(env.CONTAINER)}`,
    ].filter((p) => p !== undefined);
    if (problems.length > 0) throw new Error(problems.join("; "));
    console.log(`async job ok on node ${process.versions.node}: ${env.CONTAINER.containerName}`);
  },
};
