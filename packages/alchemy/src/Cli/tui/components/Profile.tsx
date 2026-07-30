/** @jsxImportSource react */
import { Box, render, Text, useStdout } from "ink";
import type { JSX } from "react";

export interface ProfileProviderDisplay {
  readonly name: string;
  readonly method: string;
  readonly status: "ready" | "configured" | "error";
  readonly lines: ReadonlyArray<string>;
}

export interface ProfileListDisplay {
  readonly name: string;
  readonly active: boolean;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly method: string;
  }>;
}

const naturalWidth = (header: string, cells: ReadonlyArray<string>): number =>
  Math.max(header.length, ...cells.map((cell) => cell.length));

/** Fixed width of a left-hand column: widest content plus padding. */
const columnWidth = (header: string, cells: ReadonlyArray<string>): number =>
  naturalWidth(header, cells) + 2;

/**
 * Width of the final flexible column: its natural width, clamped so the
 * table fits the terminal without squeezing the fixed columns.
 */
const flexibleWidth = (
  fixedWidth: number,
  natural: number,
  terminalColumns: number | undefined,
): number => {
  const availableWidth = Math.max(20, (terminalColumns ?? 80) - 4);
  return Math.max(16, Math.min(natural, availableWidth - fixedWidth));
};

function Frame({
  title,
  width,
  children,
}: {
  readonly title: string;
  readonly width: number;
  readonly children: JSX.Element | ReadonlyArray<JSX.Element>;
}): JSX.Element {
  return (
    <Box flexDirection="column" width={width + 4}>
      <Box
        borderColor="cyan"
        borderStyle={{
          topLeft: "╭",
          top: "─",
          topRight: "╮",
          right: "│",
          bottomRight: "┤",
          bottom: "─",
          bottomLeft: "├",
          left: "│",
        }}
        paddingX={1}
        width={width + 4}
      >
        <Text bold color="cyan">
          {title}
        </Text>
      </Box>
      <Box
        borderColor="cyan"
        borderStyle="round"
        borderTop={false}
        flexDirection="column"
        paddingX={1}
        width={width + 4}
      >
        {children}
      </Box>
    </Box>
  );
}

function ProfileList({
  profiles,
}: {
  readonly profiles: ReadonlyArray<ProfileListDisplay>;
}): JSX.Element {
  const { stdout } = useStdout();
  const providerLabels = profiles.map((profile) =>
    profile.providers.map((provider) => provider.name).join(", "),
  );
  const authLabels = profiles.map((profile) =>
    profile.providers
      .map((provider) => `${provider.name}: ${provider.method}`)
      .join(", "),
  );
  const profileWidth = columnWidth(
    "Profile",
    profiles.map((profile) => `● ${profile.name}`),
  );
  const providerWidth = columnWidth("Providers", providerLabels);
  const fixedWidth = profileWidth + providerWidth;
  const authWidth = flexibleWidth(
    fixedWidth,
    naturalWidth("Authentication", authLabels),
    stdout.columns,
  );
  const tableWidth = fixedWidth + authWidth;

  return (
    <Frame title={`Profiles (${profiles.length})`} width={tableWidth}>
      {profiles.length === 0 ? (
        <Text dimColor>
          {"No profiles configured. Run `alchemy profile create <name>`."}
        </Text>
      ) : (
        <>
          <Box>
            <Box width={profileWidth} flexShrink={0}>
              <Text bold>Profile</Text>
            </Box>
            <Box width={providerWidth} flexShrink={0}>
              <Text bold>Providers</Text>
            </Box>
            <Box width={authWidth}>
              <Text bold>Authentication</Text>
            </Box>
          </Box>
          <Text dimColor>{"─".repeat(tableWidth)}</Text>
          {profiles.map((profile, index) => (
            <Box key={profile.name}>
              <Box width={profileWidth} flexShrink={0}>
                <Text color={profile.active ? "green" : undefined}>
                  {profile.active ? "● " : "  "}
                  {profile.name}
                </Text>
              </Box>
              <Box width={providerWidth} flexShrink={0}>
                <Text>{providerLabels[index] || "—"}</Text>
              </Box>
              <Box width={authWidth}>
                <Text>{authLabels[index] || "—"}</Text>
              </Box>
            </Box>
          ))}
        </>
      )}
    </Frame>
  );
}

function ProfileDetails({
  profile,
  providers,
  active,
}: {
  readonly profile: string;
  readonly providers: ReadonlyArray<ProfileProviderDisplay>;
  readonly active: boolean;
}): JSX.Element {
  const { stdout } = useStdout();
  const providerWidth = columnWidth(
    "Provider",
    providers.map((provider) => provider.name),
  );
  const methodWidth = columnWidth(
    "Method",
    providers.map((provider) => provider.method),
  );
  const statusWidth = columnWidth(
    "Status",
    providers.map((provider) => provider.status),
  );
  const fixedWidth = providerWidth + methodWidth + statusWidth;
  const detailsWidth = flexibleWidth(
    fixedWidth,
    naturalWidth(
      "Details",
      providers.flatMap((provider) => provider.lines),
    ),
    stdout.columns,
  );
  const tableWidth = fixedWidth + detailsWidth;

  return (
    <Frame
      title={`Profile: ${profile}${active ? " (active)" : ""}`}
      width={tableWidth}
    >
      {providers.length === 0 ? (
        <Text dimColor>No providers configured.</Text>
      ) : (
        <>
          <Box>
            <Box width={providerWidth} flexShrink={0}>
              <Text bold>Provider</Text>
            </Box>
            <Box width={methodWidth} flexShrink={0}>
              <Text bold>Method</Text>
            </Box>
            <Box width={statusWidth} flexShrink={0}>
              <Text bold>Status</Text>
            </Box>
            <Box width={detailsWidth}>
              <Text bold>Details</Text>
            </Box>
          </Box>
          <Text dimColor>{"─".repeat(tableWidth)}</Text>
          {providers.map((provider, providerIndex) => (
            <Box key={provider.name} flexDirection="column">
              {providerIndex === 0 ? null : (
                <Text dimColor>{"─".repeat(tableWidth)}</Text>
              )}
              {(provider.lines.length > 0 ? provider.lines : ["—"]).map(
                (line, lineIndex) => (
                  <Box key={`${provider.name}-${lineIndex}`}>
                    <Box width={providerWidth} flexShrink={0}>
                      <Text color="blueBright">
                        {lineIndex === 0 ? provider.name : ""}
                      </Text>
                    </Box>
                    <Box width={methodWidth} flexShrink={0}>
                      <Text>{lineIndex === 0 ? provider.method : ""}</Text>
                    </Box>
                    <Box width={statusWidth} flexShrink={0}>
                      {lineIndex === 0 ? (
                        <Text
                          color={
                            provider.status === "ready"
                              ? "green"
                              : provider.status === "error"
                                ? "red"
                                : "yellow"
                          }
                        >
                          {provider.status}
                        </Text>
                      ) : null}
                    </Box>
                    <Box width={detailsWidth}>
                      <Text>{line}</Text>
                    </Box>
                  </Box>
                ),
              )}
            </Box>
          ))}
        </>
      )}
    </Frame>
  );
}

function ProfileNotice({
  profile,
  message,
}: {
  readonly profile: string;
  readonly message: string;
}): JSX.Element {
  const width = Math.max(`Profile: ${profile}`.length, message.length);
  return (
    <Frame title={`Profile: ${profile}`} width={width}>
      <Text color="yellow">{message}</Text>
    </Frame>
  );
}

function CurrentProfile({
  name,
  source,
}: {
  readonly name: string;
  readonly source: string;
}): JSX.Element {
  const labelWidth = 10;
  const valueWidth = Math.max(name.length, source.length, 7);
  return (
    <Frame title="Current profile" width={labelWidth + valueWidth}>
      <Box>
        <Box width={labelWidth}>
          <Text bold>Name</Text>
        </Box>
        <Text>{name}</Text>
      </Box>
      <Box>
        <Box width={labelWidth}>
          <Text bold>Source</Text>
        </Box>
        <Text>{source}</Text>
      </Box>
    </Frame>
  );
}

/** Render a static frame and immediately release the ink instance. */
const renderOnce = (element: JSX.Element): void => {
  render(element).unmount();
};

export const renderProfileList = (
  profiles: ReadonlyArray<ProfileListDisplay>,
): void => renderOnce(<ProfileList profiles={profiles} />);

export const renderProfileDetails = (
  profile: string,
  providers: ReadonlyArray<ProfileProviderDisplay>,
  active: boolean,
): void =>
  renderOnce(
    <ProfileDetails profile={profile} providers={providers} active={active} />,
  );

export const renderProfileNotice = (profile: string, message: string): void =>
  renderOnce(<ProfileNotice profile={profile} message={message} />);

export const renderCurrentProfile = (name: string, source: string): void =>
  renderOnce(<CurrentProfile name={name} source={source} />);
