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
toolbar gives you **Character roster**, **Grant XP now**, **Start timer**,
and **Stop timer** with one click — no console needed.

### Character roster

The roster lists every player-owned character with **Total XP**,
**Spent XP**, and **Available XP** (total minus spent).

- **Select** characters with the checkboxes, then **Grant XP to selected**
  to award the per-tick amount to just those characters.
- **Lock** a character to skip it in every grant (timer and manual).
  Locked rows can't be selected.
- **Remove** takes a character off the roster entirely (also skipped by
  grants). **Restore removed** brings everyone back.
- **Grant XP to all** awards the per-tick amount to every unlocked,
  rostered character — same as the toolbar's Grant XP now.

Or run these in a script macro or the console (`F12`):

```js
HourlyXP.start();      // start the timer
HourlyXP.stop();       // stop the timer
HourlyXP.grantNow();   // one manual grant right now
HourlyXP.status();     // { running, ticks, nextTickInSeconds }
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
