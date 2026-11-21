/**
 * The local URL of a Docker service's port. Fronts publish their port on one
 * Swarm picks, so a suite runs beside itself in other worktrees, and read it
 * back from the service's `ports` after the deploy.
 */
export const publishedUrl = (
  ports: ReadonlyArray<{ readonly external?: number; readonly internal: number }>,
  internal = 3000,
) => `http://localhost:${ports.find((port) => port.internal === internal)?.external}`;
