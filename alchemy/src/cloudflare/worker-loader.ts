/**
 * A binding for dynamic worker loaders.
 *
 */
export interface WorkerLoader {
  type: "worker_loader";
}
export function WorkerLoader(): WorkerLoader {
  return {
    type: "worker_loader",
  };
}
