/** @jsxImportSource react */
import {
  Box,
  Gutter,
  SectionHeading,
  Spinner,
  Text,
  useBorderStyle,
  useGlyphs,
} from "../ui/index.ts";
import { stringWidth } from "@alchemy.run/sigil/ansi";
import type { JSX } from "react";
import { theme } from "../../CliKit/index.ts";

export interface ProfileProviderDisplay {
  readonly name: string;
  readonly method: string;
  readonly status: "ready" | "configured" | "reauth" | "reconfigure" | "error";
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

/** Provider credential status → glyph + color + label, shared with the dashboard. */
export const providerStatusStyle = {
  ready: {
    color: theme.color.success,
    glyph: "success",
    label: "ready",
  },
  configured: {
    color: theme.color.warning,
    glyph: "warning",
    label: "configured",
  },
  reauth: {
    color: theme.color.warning,
    glyph: "refresh",
    label: "needs re-login",
  },
  reconfigure: {
    color: theme.color.warning,
    glyph: "edit",
    label: "needs setup",
  },
  error: {
    color: theme.color.danger,
    glyph: "error",
    label: "error",
  },
} as const;

/**
 * Styling for the account-edit flow's row states, shared between the
 * `profile edit` cycle prompt and the dashboard's edit screen. `keep` is
 * the neutral state for connected providers, `skip` for unconnected ones.
 */
export const editStateStyle = {
  keep: {
    icon: "selected",
    variant: "success",
    label: undefined,
  },
  skip: {
    icon: "unselected",
    variant: "neutral",
    label: undefined,
  },
  add: {
    icon: "add",
    variant: "success",
    label: "add",
  },
  reconfigure: {
    icon: "edit",
    variant: "warning",
    label: "reconfigure",
  },
  remove: {
    icon: "error",
    variant: "error",
    label: "remove",
  },
} as const;

export type EditState = keyof typeof editStateStyle;

const columnWidth = (cells: ReadonlyArray<string>): number =>
  Math.max(0, ...cells.map((cell) => cell.length)) + 2;

/** `cloudflare (oauth) · aws (sso)` with dim methods and separators. */
type ProviderSummaryProps = {
  readonly providers: ReadonlyArray<{ name: string; method: string }>;
};

function ProviderSummary({ providers }: ProviderSummaryProps): JSX.Element {
  return providers.length === 0 ? (
    <Text tone="muted">no providers</Text>
  ) : (
    <Text>
      {providers.map((provider, i) => (
        <Text key={provider.name}>
          {i === 0 ? null : <Text tone="muted"> · </Text>}
          {provider.name}
          <Text tone="muted"> ({provider.method})</Text>
        </Text>
      ))}
    </Text>
  );
}

function ProfileList({
  profiles,
}: {
  readonly profiles: ReadonlyArray<ProfileListDisplay>;
}): JSX.Element {
  const glyphs = useGlyphs();
  const borderStyle = useBorderStyle();
  const nameWidth = columnWidth(profiles.map((profile) => profile.name));
  return (
    <Box flexDirection="column">
      <Box
        marginBottom={1}
        borderStyle={borderStyle}
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.color.muted}
        borderDimColor
      >
        <SectionHeading annotation={`${profiles.length}`}>
          Profiles
        </SectionHeading>
      </Box>
      {profiles.length === 0 ? (
        <Gutter>
          <Text tone="muted">
            {"No profiles configured. Run `alchemy profile` to create one."}
          </Text>
        </Gutter>
      ) : (
        profiles.map((profile) => (
          <Gutter key={profile.name}>
            <Box flexDirection="row">
              <Text tone="brand">{profile.active ? glyphs.selected : " "}</Text>
              <Text> </Text>
              <Box width={nameWidth} flexShrink={0}>
                <Text bold={profile.active}>{profile.name}</Text>
              </Box>
              <ProviderSummary providers={profile.providers} />
            </Box>
          </Gutter>
        ))
      )}
    </Box>
  );
}

/** Options every provider block shares; the dashboard threads them through. */
export interface ProviderBlockOptions {
  /** Muted hint appended to rows with `status: "reauth"`. */
  readonly reauthHint?: string;
  /** Provider whose detail rows are temporarily replaced by refresh status. */
  readonly refreshingProvider?: string;
  /** Provider currently focused by an interactive parent view. */
  readonly focusedProvider?: string;
  /** Reserve a stable focus rail column for an interactive parent view. */
  readonly showFocusRail?: boolean;
}

/** Column widths computed over every provider so windowed blocks stay aligned. */
export const providerColumnWidths = (
  providers: ReadonlyArray<ProfileProviderDisplay>,
): { readonly nameWidth: number; readonly methodWidth: number } => ({
  nameWidth: columnWidth(providers.map((provider) => provider.name)),
  methodWidth: columnWidth(providers.map((provider) => provider.method)),
});

/**
 * Rows a `ProviderBlock` occupies: separator and padding above every block
 * but the first, the header row, then a blank row and the detail rows (the
 * refresh spinner fits inside that same reserved height). The dashboard
 * windows providers by this number, so keep it in step with the layout.
 */
export const providerBlockHeight = (
  provider: ProfileProviderDisplay,
  first: boolean,
): number => (first ? 0 : 2) + 1 + Math.max(provider.lines.length, 1) + 1;

/**
 * Columns the widest provider block needs. A windowed pane only lays out the
 * blocks on screen, so it sizes itself by this instead, keeping the separators
 * the width of the whole table rather than of the terminal.
 */
export const providerPaneWidth = (
  providers: ReadonlyArray<ProfileProviderDisplay>,
  { showFocusRail = false, reauthHint }: ProviderBlockOptions = {},
): number => {
  const { nameWidth, methodWidth } = providerColumnWidths(providers);
  const indent = (showFocusRail ? 1 : 0) + theme.space.indent;
  return Math.max(
    0,
    ...providers.flatMap((provider) => {
      const status = providerStatusStyle[provider.status];
      const hint =
        reauthHint !== undefined && provider.status === "reauth"
          ? stringWidth(` — ${reauthHint}`)
          : 0;
      // glyph, space, label
      const header =
        indent + nameWidth + methodWidth + 2 + stringWidth(status.label) + hint;
      return [
        header,
        ...provider.lines.map((line) => indent + 2 + stringWidth(line)),
      ];
    }),
  );
};

/** One provider's header and detail rows; `first` drops the separator above. */
export function ProviderBlock({
  provider,
  first,
  nameWidth,
  methodWidth,
  reauthHint,
  refreshingProvider,
  focusedProvider,
  showFocusRail = false,
}: ProviderBlockOptions & {
  readonly provider: ProfileProviderDisplay;
  readonly first: boolean;
  readonly nameWidth: number;
  readonly methodWidth: number;
}): JSX.Element {
  const glyphs = useGlyphs();
  const borderStyle = useBorderStyle();
  const status = providerStatusStyle[provider.status];
  const focused = showFocusRail && provider.name === focusedProvider;
  return (
    <Box
      flexDirection="column"
      paddingTop={first ? 0 : 1}
      paddingLeft={showFocusRail ? (focused ? 0 : 1) : 0}
      borderStyle={borderStyle}
      borderTop={!first}
      borderBottom={false}
      borderLeft={focused}
      borderRight={false}
      borderColor={theme.color.muted}
      borderLeftColor={theme.color.brand}
      borderDimColor
    >
      <Gutter>
        <Box flexDirection="row">
          <Box width={nameWidth} flexShrink={0}>
            <Text bold color={theme.color.accent}>
              {provider.name}
            </Text>
          </Box>
          <Box width={methodWidth} flexShrink={0}>
            <Text tone="muted">{provider.method}</Text>
          </Box>
          <Text color={status.color}>
            {glyphs[status.glyph]} {status.label}
          </Text>
          {reauthHint !== undefined &&
          provider.status === "reauth" &&
          (focusedProvider === undefined ||
            provider.name === focusedProvider) ? (
            <Text tone="muted"> — {reauthHint}</Text>
          ) : null}
        </Box>
      </Gutter>
      <Box
        flexDirection="column"
        minHeight={Math.max(provider.lines.length, 1) + 1}
      >
        {provider.name === refreshingProvider ? (
          <Gutter>
            <Box paddingLeft={2} marginTop={1}>
              <Spinner
                label={`refreshing ${provider.method.toLowerCase() === "oauth" ? "OAuth" : provider.method} credentials…`}
              />
            </Box>
          </Gutter>
        ) : (
          provider.lines.map((line, lineIndex) => (
            <Gutter key={`${provider.name}-${lineIndex}`}>
              <Box paddingLeft={2} marginTop={lineIndex === 0 ? 1 : 0}>
                <Text>{line}</Text>
              </Box>
            </Gutter>
          ))
        )}
      </Box>
    </Box>
  );
}

/**
 * Provider table body shared by `profile show` and the dashboard's detail
 * pane, so the two render identically. The dashboard passes `reauthHint` to
 * advertise its `r` keybinding on rows that need a re-login.
 */
export function ProfileDetailsBody({
  providers,
  ...options
}: ProviderBlockOptions & {
  readonly providers: ReadonlyArray<ProfileProviderDisplay>;
}): JSX.Element {
  const { nameWidth, methodWidth } = providerColumnWidths(providers);
  return (
    <Box flexDirection="column">
      {providers.length === 0 ? (
        <Gutter>
          <Text tone="muted">No providers configured.</Text>
        </Gutter>
      ) : (
        providers.map((provider, index) => (
          <ProviderBlock
            key={provider.name}
            provider={provider}
            first={index === 0}
            nameWidth={nameWidth}
            methodWidth={methodWidth}
            {...options}
          />
        ))
      )}
    </Box>
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
  const borderStyle = useBorderStyle();
  return (
    <Box flexDirection="column">
      <Box
        marginBottom={1}
        borderStyle={borderStyle}
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.color.muted}
        borderDimColor
      >
        <SectionHeading annotation={active ? "active" : undefined}>
          Profile {profile}
        </SectionHeading>
      </Box>
      <ProfileDetailsBody providers={providers} />
    </Box>
  );
}

function ProfileNotice({
  profile,
  message,
}: {
  readonly profile: string;
  readonly message: string;
}): JSX.Element {
  const glyphs = useGlyphs();
  const borderStyle = useBorderStyle();
  return (
    <Box flexDirection="column">
      <Box
        marginBottom={1}
        borderStyle={borderStyle}
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.color.muted}
        borderDimColor
      >
        <SectionHeading>Profile {profile}</SectionHeading>
      </Box>
      <Gutter>
        <Text color={theme.color.warning}>
          {glyphs.warning} {message}
        </Text>
      </Gutter>
    </Box>
  );
}

function CurrentProfile({
  name,
  source,
}: {
  readonly name: string;
  readonly source: string;
}): JSX.Element {
  const glyphs = useGlyphs();
  return (
    <Text>
      <Text tone="brand">{glyphs.selected}</Text> <Text bold>{name}</Text>{" "}
      <Text tone="muted">({source})</Text>
    </Text>
  );
}

/**
 * View builders consumed by `CliKit.print` and the interactive profile app.
 */
export const profileListNode = (
  profiles: ReadonlyArray<ProfileListDisplay>,
): JSX.Element => <ProfileList profiles={profiles} />;

export const profileDetailsNode = (
  profile: string,
  providers: ReadonlyArray<ProfileProviderDisplay>,
  active: boolean,
): JSX.Element => (
  <ProfileDetails profile={profile} providers={providers} active={active} />
);

export const profileNoticeNode = (
  profile: string,
  message: string,
): JSX.Element => <ProfileNotice profile={profile} message={message} />;

export const currentProfileNode = (
  name: string,
  source: string,
): JSX.Element => <CurrentProfile name={name} source={source} />;
