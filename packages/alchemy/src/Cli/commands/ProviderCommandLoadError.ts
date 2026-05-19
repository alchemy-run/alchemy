import * as Data from "effect/Data";
import {
  type DependencyGroup,
  makeAddCommand,
} from "../../ProviderDependencies.ts";

export class ProviderCommandLoadError extends Data.TaggedError(
  "ProviderCommandLoadError",
)<{
  readonly message: string;
  readonly provider: string;
  readonly installCommand: string;
  readonly cause: unknown;
}> {}

export const makeProviderCommandLoadError = ({
  command,
  group,
  cause,
}: {
  readonly command: string;
  readonly group: DependencyGroup;
  readonly cause: unknown;
}) => {
  const installCommand = makeAddCommand(group.packages);
  return new ProviderCommandLoadError({
    message: `${command} needs the ${group.label} packages before it can load its provider module. Run ${installCommand}, then run the command again.`,
    provider: group.label,
    installCommand,
    cause,
  });
};
