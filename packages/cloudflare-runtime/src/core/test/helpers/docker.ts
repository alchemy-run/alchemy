import { execFileSync } from "node:child_process";

export const isDockerAvailable = () => {
  // Local containers require Linux images; Windows users run through WSL.
  if (process.platform === "win32") return false;
  try {
    execFileSync(process.env.DOCKER_BIN ?? "docker", ["info"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
};
