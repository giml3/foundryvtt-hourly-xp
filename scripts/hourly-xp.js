/**
 * Hourly XP — Foundry VTT module
 * Automatically grants XP to every player-owned character on a repeating
 * real-time timer. Designed for 24-hour marathon sessions.
 *
 * The timer runs only on the active GM's client, so it never double-grants.
 * If Foundry (or the GM's browser) restarts, restart the timer with the
 * macro API below or enable "Auto-start on ready" in module settings.
 *
 * Macro API (run as GM):
 *   game.modules.get("hourly-xp").api.start();     // start the timer
 *   game.modules.get("hourly-xp").api.stop();      // stop the timer
 *   game.modules.get("hourly-xp").api.grantNow();   // one manual grant now
 *   game.modules.get("hourly-xp").api.status();    // running? ticks? next in?
 *
 * A GM-only toolbar button (star icon, left toolbar) exposes the character
 * roster, Grant Now, Start, and Stop without touching the console.
 */

const MODULE_ID = "hourly-xp";

let xpTimer = null;
let tickCount = 0;
let lastTickAt = 0;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** True only on the one GM client that should own the timer. */
function iAmActiveGM() {
  const activeGM = game.users?.activeGM;
  return !!activeGM && activeGM.id === game.user?.id && game.user.isGM;
}

/** Player-owned, non-synthetic character actors (WFRP4e "character" type). */
function playerCharacters() {
  return (game.actors?.contents ?? []).filter(
    (a) => a.type === "character" && a.hasPlayerOwner && !a.isToken
  );
}

/** Read an actor's XP, tolerating WFRP4e data-model variants. */
function readXp(actor) {
  const xp = actor.system?.details?.experience ?? {};
  const total = Number(xp.total ?? xp.value ?? 0) || 0;
  const spent = Number(xp.spent ?? 0) || 0;
  return {
    total,
    spent,
    available: total - spent,
    key: xp.total !== undefined ? "total" : "value",
  };
}

/** XP granted per tick, from module settings. */
function xpPerTick() {
  return Math.max(0, Number(game.settings.get(MODULE_ID, "xpPerTick")) || 0);
}

/** Actor IDs locked out of XP grants (world setting). */
function getLocked() {
  return game.settings.get(MODULE_ID, "lockedActors") || {};
}

/** Actor IDs removed from the roster (world setting). */
function getExcluded() {
  return game.settings.get(MODULE_ID, "excludedActors") || {};
}

function isLocked(id) {
  return !!getLocked()[id];
}

async function toggleLock(id) {
  const locked = { ...getLocked() };
  if (locked[id]) delete locked[id];
  else locked[id] = true;
  await game.settings.set(MODULE_ID, "lockedActors", locked);
}

async function excludeActor(id) {
  await game.settings.set(MODULE_ID, "excludedActors", { ...getExcluded(), [id]: true });
}

async function restoreExcluded() {
  await game.settings.set(MODULE_ID, "excludedActors", {});
}

/** Player characters currently on the roster (not removed). */
function rosterActors() {
  const excluded = getExcluded();
  return playerCharacters().filter((a) => !excluded[a.id]);
}

/** Grant `amount` XP to every unlocked, rostered player character. Returns count granted. */
async function grantXpToAll(amount) {
  const locked = getLocked();
  const excluded = getExcluded();
  const targets = playerCharacters().filter((a) => !locked[a.id] && !excluded[a.id]);
  for (const actor of targets) {
    const { key, total } = readXp(actor);
    await actor.update({ [`system.details.experience.${key}`]: total + amount });
  }
  return targets.length;
}

/** Grant `amount` XP to the given actor IDs (locked actors are skipped). Returns count granted. */
async function grantXpToIds(amount, ids) {
  const wanted = new Set(ids);
  const targets = playerCharacters().filter((a) => wanted.has(a.id) && !isLocked(a.id));
  for (const actor of targets) {
    const { key, total } = readXp(actor);
    await actor.update({ [`system.details.experience.${key}`]: total + amount });
  }
  return targets.length;
}

function announce(html) {
  ChatMessage.create({
    content: html,
    speaker: { alias: "Hourly XP" },
  }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Timer control                                                       */
/* ------------------------------------------------------------------ */

function stopTimer(silent = false) {
  if (xpTimer) {
    clearInterval(xpTimer);
    xpTimer = null;
    if (!silent) ui.notifications?.info("Hourly XP stopped.");
  }
}

function startTimer() {
  if (!iAmActiveGM()) {
    ui.notifications?.warn("Hourly XP: only the active GM can start the timer.");
    return false;
  }
  stopTimer(true);
  const minutes = Math.max(1, Number(game.settings.get(MODULE_ID, "intervalMinutes")) || 60);
  const amount = Math.max(0, Number(game.settings.get(MODULE_ID, "xpPerTick")) || 0);
  tickCount = 0;
  lastTickAt = Date.now();
  xpTimer = setInterval(onTick, minutes * 60 * 1000);
  ui.notifications?.info(`Hourly XP started: ${amount} XP every ${minutes} minute(s).`);
  return true;
}

async function onTick() {
  if (!iAmActiveGM()) return; // GM changed mid-session; stay quiet
  const amount = xpPerTick();
  const count = await grantXpToAll(amount);
  tickCount += 1;
  lastTickAt = Date.now();
  if (game.settings.get(MODULE_ID, "announceInChat")) {
    const minutes = game.settings.get(MODULE_ID, "intervalMinutes");
    announce(
      `<p><strong>Hourly XP</strong> — granted <strong>${amount} XP</strong> ` +
      `to ${count} character(s) (tick ${tickCount}, every ${minutes} min).</p>`
    );
  }
}

async function grantNow() {
  if (!iAmActiveGM()) {
    ui.notifications?.warn("Hourly XP: only the active GM can grant XP.");
    return 0;
  }
  const amount = xpPerTick();
  const count = await grantXpToAll(amount);
  ui.notifications?.info(`Hourly XP: granted ${amount} XP to ${count} character(s).`);
  return count;
}

function status() {
  const minutes = Number(game.settings.get(MODULE_ID, "intervalMinutes")) || 60;
  const nextIn = xpTimer
    ? Math.max(0, Math.round((minutes * 60 * 1000 - (Date.now() - lastTickAt)) / 1000))
    : null;
  return { running: !!xpTimer, ticks: tickCount, nextTickInSeconds: nextIn };
}

/* ------------------------------------------------------------------ */
/* Character roster window (GM only)                                    */
/* ------------------------------------------------------------------ */

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

class XPRoster extends Application {
  constructor() {
    super();
    this.selected = new Set();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "hourly-xp-roster",
      title: "Hourly XP — Character Roster",
      width: 640,
      height: 480,
      resizable: true,
    });
  }

  getData() {
    const locked = getLocked();
    const actors = rosterActors();
    const ids = new Set(actors.map((a) => a.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    return {
      rows: actors.map((a) => {
        const { total, spent, available } = readXp(a);
        return {
          id: a.id,
          name: a.name,
          img: a.img,
          total,
          spent,
          available,
          locked: !!locked[a.id],
          selected: this.selected.has(a.id),
        };
      }),
    };
  }

  async _renderInner(data) {
    const body = data.rows.length
      ? data.rows
          .map(
            (r) => `
        <tr data-actor-id="${r.id}">
          <td class="c"><input type="checkbox" class="sel" ${r.selected ? "checked" : ""} ${
              r.locked ? "disabled" : ""
            }></td>
          <td><img src="${r.img}" width="28" height="28" style="vertical-align:middle"> ${escHtml(r.name)}${
              r.locked ? ' <i class="fas fa-lock" title="Locked — skipped by grants"></i>' : ""
            }</td>
          <td class="n">${r.total}</td>
          <td class="n">${r.spent}</td>
          <td class="n">${r.available}</td>
          <td class="c"><button type="button" class="lock-btn" title="${
            r.locked ? "Unlock" : "Lock"
          }"><i class="fas fa-${r.locked ? "lock-open" : "lock"}"></i></button></td>
          <td class="c"><button type="button" class="remove-btn" title="Remove from roster"><i class="fas fa-times"></i></button></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="7" class="c">No player characters found.</td></tr>`;
    return $(`
      <div class="hourly-xp-roster">
        <style>
          .hourly-xp-roster table { width: 100%; border-collapse: collapse; }
          .hourly-xp-roster th, .hourly-xp-roster td { padding: 4px 6px; border-bottom: 1px solid #555; text-align: left; }
          .hourly-xp-roster td.n, .hourly-xp-roster th.n { text-align: right; font-variant-numeric: tabular-nums; }
          .hourly-xp-roster td.c, .hourly-xp-roster th.c { text-align: center; }
          .hourly-xp-roster .actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
          .hourly-xp-roster .hint { opacity: 0.75; font-size: 0.85em; }
        </style>
        <table>
          <thead><tr><th class="c">Select</th><th>Character</th><th class="n">Total XP</th><th class="n">Spent XP</th><th class="n">Available</th><th class="c">Lock</th><th class="c">Remove</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
        <div class="actions">
          <button type="button" class="grant-selected"><i class="fas fa-gift"></i> Grant XP to selected</button>
          <button type="button" class="grant-all"><i class="fas fa-users"></i> Grant XP to all</button>
          <button type="button" class="restore"><i class="fas fa-undo"></i> Restore removed</button>
        </div>
        <p class="hint">Locked characters are skipped by the timer and manual grants. Removed characters leave the roster and are skipped too — restore them here.</p>
      </div>`);
  }

  activateListeners(html) {
    super.activateListeners(html);
    const idOf = (el) => el.closest("tr")?.dataset.actorId;
    html.find("input.sel").on("change", (ev) => {
      const id = idOf(ev.currentTarget);
      if (!id) return;
      if (ev.currentTarget.checked) this.selected.add(id);
      else this.selected.delete(id);
    });
    html.find(".lock-btn").on("click", async (ev) => {
      const id = idOf(ev.currentTarget);
      if (id) {
        await toggleLock(id);
        this.render();
      }
    });
    html.find(".remove-btn").on("click", async (ev) => {
      const id = idOf(ev.currentTarget);
      if (id) {
        await excludeActor(id);
        this.render();
      }
    });
    html.find(".grant-selected").on("click", async () => {
      const amount = xpPerTick();
      const count = await grantXpToIds(amount, [...this.selected]);
      ui.notifications?.info(`Hourly XP: granted ${amount} XP to ${count} character(s).`);
      this.render();
    });
    html.find(".grant-all").on("click", async () => {
      await grantNow();
      this.render();
    });
    html.find(".restore").on("click", async () => {
      await restoreExcluded();
      this.render();
    });
  }
}

let rosterApp = null;

/** Open the GM's character roster window. */
function openRoster() {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Hourly XP: only the GM can open the roster.");
    return;
  }
  if (!rosterApp) rosterApp = new XPRoster();
  rosterApp.render(true);
}

/* ------------------------------------------------------------------ */
/* Toolbar button (GM only)                                             */
/* ------------------------------------------------------------------ */

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const tools = [
    { name: "roster", title: "Character roster", icon: "fas fa-users", action: () => openRoster() },
    { name: "grantNow", title: "Grant XP now", icon: "fas fa-gift", action: () => grantNow() },
    { name: "start", title: "Start timer", icon: "fas fa-play", action: () => startTimer() },
    { name: "stop", title: "Stop timer", icon: "fas fa-stop", action: () => stopTimer() },
  ];

  if (Array.isArray(controls)) {
    // Foundry v11–v12: controls is an array, tools is an array, callbacks are onClick.
    controls.push({
      name: "hourly-xp",
      title: "Hourly XP",
      icon: "fas fa-star",
      activeTool: "roster",
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title,
        icon: t.icon,
        button: true,
        onClick: t.action,
      })),
    });
  } else {
    // Foundry v13+: controls and tools are records keyed by name, callbacks are onChange.
    const toolRecord = {};
    for (const t of tools) {
      toolRecord[t.name] = {
        name: t.name,
        title: t.title,
        icon: t.icon,
        button: true,
        onChange: t.action,
      };
    }
    controls["hourly-xp"] = {
      name: "hourly-xp",
      title: "Hourly XP",
      icon: "fas fa-star",
      tools: toolRecord,
    };
  }
});

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "intervalMinutes", {
    name: "Interval (minutes)",
    hint: "Real-time minutes between XP grants. Default 60.",
    scope: "world",
    config: true,
    type: Number,
    default: 60,
  });

  game.settings.register(MODULE_ID, "xpPerTick", {
    name: "XP per grant",
    hint: "How much XP each player character receives per tick.",
    scope: "world",
    config: true,
    type: Number,
    default: 100,
  });

  game.settings.register(MODULE_ID, "announceInChat", {
    name: "Announce in chat",
    hint: "Post a chat message each time XP is granted.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "autoStart", {
    name: "Auto-start on ready",
    hint: "Automatically start the timer when the active GM's client loads. Useful if Foundry restarts mid-marathon.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "lockedActors", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.register(MODULE_ID, "excludedActors", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  const api = { start: startTimer, stop: () => stopTimer(), grantNow, status, roster: openRoster };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  // Also expose globally for macro convenience.
  globalThis.HourlyXP = api;
});

Hooks.once("ready", () => {
  if (game.settings.get(MODULE_ID, "autoStart")) startTimer();
});

// Keep the open roster fresh when actors change.
for (const hook of ["createActor", "updateActor", "deleteActor"]) {
  Hooks.on(hook, () => {
    if (rosterApp?.rendered) rosterApp.render();
  });
}
