# Hourly XP — Foundry VTT module

Automatically grants XP to every player-owned character on a repeating
**real-time** timer. Built for the 24-hour charity marathon (e.g. 100 XP
per hour so the party climbs toward tier 4 over the session).

## Install

1. Copy the `hourly-xp` folder into your Foundry `Data/modules/` directory,
   so you have `Data/modules/hourly-xp/module.json`.
2. In Foundry: **Game Settings → Manage Modules**, check **Hourly XP**, save.
3. **Game Settings → Module Settings → Hourly XP**: set the interval
   (minutes, default 60), XP per grant (default 100), chat announcements,
   and auto-start.

## Use

The timer runs **only on the active GM's client**, so XP is never
double-granted, even with multiple GMs online.

**Toolbar button (GM only):** a star icon in the left scene-controls
toolbar gives you **Character roster**, **Donation FX**, **Grant XP now**,
**Start timer**, **Stop timer**, and a **clock button** to change the tick
interval (with 1/5/15/60-minute presets — handy for testing) with one
click — no console needed.

### Character roster / DM dashboard

The roster lists every player-owned character with **Total XP**,
**Spent XP**, **Available XP** (total minus spent), and a rough
**power tier** from total XP earned (Novice → Seasoned → Veteran →
Heroic → Legendary). Tiers are a DM's at-a-glance guide, not official
WFRP4e brackets.

A status bar across the top shows:

- **Next XP drop** — live countdown to the next timer tick
  (or "timer stopped")
- **Session** — XP granted by the module since the timer was started
- **All-time** — XP granted by the module across all sessions
  (stored as a world setting; reset it in Module Settings)
- **Party tier** — tier of the party's average total XP

- **Select** characters with the checkboxes, then **Grant XP to selected**
  to award the per-tick amount to just those characters.
- **Lock** a character to skip it in every grant (timer and manual).
  Locked rows can't be selected.
- **Remove** takes a character off the roster entirely (also skipped by
  grants). **Restore removed** brings everyone back.
- **Grant XP to all** awards the per-tick amount to every unlocked,
  rostered character — same as the toolbar's Grant XP now.

### Ticker HUD

The roster's ticker facts — next-drop countdown, session/all-time XP,
party tier, DOUBLE XP status — also live in a small always-visible box
pinned to the top of the players panel, just above the latency/FPS
readout. The countdown ticks every second, no need to open the roster
mid-session. Labels are kept short and rows never wrap, so it stays
readable in the narrow panel.

### Blessings on every tick

Each timer tick is a small ceremony: **LARGE text** fades in at the
center of the screen — "Sigmar's Blessing" plus one of **8 rotating
blessings of Sigmar**, e.g. *"Sigmar's blessing has been bestowed — you
feel empowered!"* — holds a few seconds, then fades. Chat proclaims the
blessing too, followed by the mechanical summary. Vanilla DOM, no extra
modules needed. Toggle with the **Celebration visuals** module setting.

### Donation FX panel

The toolbar's **Donation FX** button (or `HourlyXP.fxPanel()`) opens a
panel with a one-click **center-screen banner** for **every item on the
donation incentives list** — 19 total. Big text fades in mid-screen
(gold for player boons, purple for GM chaos, bright white-gold for
milestones), holds, then fades:

- **Player ($5–$30):** Second Chance, Blessed Crit, Divine Swiftness,
  Sigmar's Hand, Cheat Morr, Blessing of Sigmar
- **Chaos ($10–$30):** GM Intrusion, Fumble Curse, Cruel Complication,
  Whisper of Betrayal, Ruin the Plan
- **Milestones ($250–$2,000):** Hidden Truth, Bonus Boss, Seize the Dice,
  CHAOS HOUR, Chat Forges, DOUBLE XP, Fate Restored, Finale Wish

Pick a character from the Target dropdown, or leave it on Whole party.
Milestones are party-wide. Each effect flashes its banner and posts a
flavor proclamation in chat.

Every FX fired is logged in the panel's **FX history** (time, effect,
target, price) with a running **donations total** — handy for tracking
the marathon's fundraising live. The log persists in the world; **Clear**
wipes it. `HourlyXP.fxHistory()` returns the raw entries.

The **$1,500 DOUBLE XP** milestone is functional: it doubles the per-tick
grant for the next 4 real-time hours. The roster dashboard shows a
`DOUBLE XP — 3h 12m left` badge while it's active, and
`HourlyXP.status()` reports `xpMultiplier` / `doubleXpEndsInSeconds`.

Or fire effects from a macro / the console (`F12`):

```js
HourlyXP.fx("crit", "Zelp");  // Blessed Crit on Zelp ($10)
HourlyXP.fx("chaosHour");     // CHAOS HOUR, party-wide ($1,000)
HourlyXP.fx("doubleXp");      // arm 4h double XP ($1,500)
HourlyXP.fxList();            // all 19 keys, labels, prices
HourlyXP.setInterval(2);      // 2-minute ticks, restarts the timer
HourlyXP.intervalPanel();     // clock-button interval dialog
```

### XP reasons and the system dialog

Grants go through the WFRP4e system's native `awardExp`, so each grant
writes a proper entry to the character's XP log — and the system's
"Reason for XP change" dialog never pops up per character.

- **Manual grants** (toolbar or roster buttons) ask for the reason
  **once**, then apply it to everyone receiving XP.
- **Timer ticks** never prompt; they log the **Default XP reason**
  from module settings (default `"Hourly XP"`).

Or run these in a script macro or the console (`F12`):

```js
HourlyXP.start();      // start the timer
HourlyXP.stop();       // stop the timer
HourlyXP.grantNow();   // one manual grant right now
HourlyXP.status();     // { running, ticks, nextTickInSeconds, sessionGranted, totalGranted, xpMultiplier, doubleXpEndsInSeconds }
HourlyXP.roster();     // open the character roster window
```

(`game.modules.get("hourly-xp").api` exposes the same four functions.)

## Notes

- Grants go to actors of type `character` that have a player owner.
  Token-copies are skipped, NPCs are skipped. Locked and removed
  characters are skipped too.
- Works with the WFRP4e experience model (`details.experience.total`,
  falling back to `value` on older data).
- The timer lives in the GM's browser session. If Foundry or the browser
  restarts mid-marathon, restart it with `HourlyXP.start()` — or turn on
  **Auto-start on ready** in module settings and forget about it.
- Tested logic only; enable it in a test world first and watch one tick
  before the marathon.

## Files

- `module.json` — module manifest (Foundry v11+, verified on v13)
- `scripts/hourly-xp.js` — the whole module
