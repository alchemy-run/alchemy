import * as Archil from "@alchemy.run/archil";

/** A disk the Effect program reads through `ReadDisk`. */
export const ProgramData = Archil.Disk("ProgramData", {});

/** A disk the Effect program's sandbox mounts through `MountDisk`. */
export const ProgramMount = Archil.Disk("ProgramMount", {});

/** The async program, declared with a greeting so a redeploy can change it. */
export const asyncHello = (greeting: string) =>
  Archil.Sandbox("AsyncHello", {
    main: `${import.meta.dirname}/async.ts`,
    port: 3001,
    idleTtlSeconds: 300,
    env: { GREETING: greeting },
  });

export type HelloEnv = Archil.InferEnv<ReturnType<typeof asyncHello>>;
