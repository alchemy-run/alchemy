import { brand, mono } from "../theme.ts";
import { Box, Caption, Em, Rise, Scene, useRise } from "../ui.tsx";

const Arrow = ({ at, label }: { at: number; label?: string }) => {
  const shown = useRise(at, 10);
  return (
    <div style={{ width: 150, opacity: shown, textAlign: "center" }}>
      <div style={{ fontFamily: mono, fontSize: 20, color: brand.fgMuted, height: 30 }}>
        {label}
      </div>
      <div
        style={{
          height: 3,
          background: brand.fgMuted,
          width: `${shown * 100}%`,
          margin: "6px 0 36px",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            right: -2,
            top: -8,
            borderLeft: `14px solid ${brand.fgMuted}`,
            borderTop: "9px solid transparent",
            borderBottom: "9px solid transparent",
          }}
        />
      </div>
    </div>
  );
};

/** What a Domain model is: commands decided into events, folded into state, reacted to. */
export const Model = ({ length }: { length: number }) => (
  <Scene
    kicker="Alchemy Domain"
    title="A model is commands, decided into events, folded into state"
    length={length}
  >
    <div style={{ display: "flex", alignItems: "center", marginTop: 40 }}>
      <Rise at={20}>
        <Box color={brand.sky} style={{ width: 290 }}>
          Command
          <div style={{ fontFamily: mono, fontSize: 21, fontWeight: 400, marginTop: 8 }}>
            WithdrawMoney
          </div>
        </Box>
      </Rise>
      <Arrow at={34} label="decide" />
      <Rise at={46}>
        <Box color={brand.gold} style={{ width: 290 }}>
          Events
          <div style={{ fontFamily: mono, fontSize: 21, fontWeight: 400, marginTop: 8 }}>
            MoneyWithdrawn
          </div>
        </Box>
      </Rise>
      <Arrow at={60} label="evolve" />
      <Rise at={72}>
        <Box color={brand.moss} style={{ width: 290 }}>
          State
          <div style={{ fontFamily: mono, fontSize: 21, fontWeight: 400, marginTop: 8 }}>
            {"{ balance: 70 }"}
          </div>
        </Box>
      </Rise>
    </div>
    <Rise at={86} style={{ marginTop: 28, fontSize: 28, color: brand.fgMuted }}>
      An aggregate decides alone. A decision decides across several, and commits all or nothing.
    </Rise>
    <div style={{ display: "flex", gap: 28, marginTop: 56 }}>
      {[
        ["Policies", "react to an event with a command"],
        ["Sagas", "run steps that take time, and undo them"],
        ["Views", "fold events into what a screen reads"],
        ["External systems", "answer what their schema allows"],
      ].map(([name, what], index) => (
        <Rise key={name} at={130 + index * 14} style={{ flex: 1 }}>
          <Box color={brand.ember} style={{ textAlign: "left", height: 150 }}>
            {name}
            <div style={{ fontSize: 23, fontWeight: 400, color: brand.fgMuted, marginTop: 10 }}>
              {what}
            </div>
          </Box>
        </Rise>
      ))}
    </div>
    <Caption at={200}>
      It runs on Durable Objects, Rivet, Effect Cluster, or in memory.{" "}
      <Em>decide and evolve are plain functions</Em>, so they can be read as logic.
    </Caption>
  </Scene>
);
