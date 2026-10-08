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
 * A GM-only toolbar button (star icon, left toolbar) exposes Grant Now,
 * Start, and Stop without touching the console.

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

/** Read the actor's total XP, tolerating WFRP4e data-model variants. */
function readTotalXp(actor) {
  const xp = actor.system?.details?.experience ?? {};
  const total = xp.total ?? xp.value ?? 0;
  return { xp, total: Number(total) || 0, key: xp.total !== undefined ? "total" : "value" };
}

/** Grant `amount` XP to every player character. Returns count granted. */
async function grantXpToAll(amount) {
  const chars = playerCharacters();
  for (const actor of chars) {
    const { key, total } = readTotalXp(actor);
    await actor.update({ [`system.details.experience.${key}`]: total + amount });
  }
  return chars.length;
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
  const amount = Math.max(0, Number(game.settings.get(MODULE_ID, "xpPerTick")) || 0);
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
  const amount = Math.max(0, Number(game.settings.get(MODULE_ID, "xpPerTick")) || 0);
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
/* Toolbar button (GM only)                                             */
/* ------------------------------------------------------------------ */

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  controls.push({
    name: "hourly-xp",
    title: "Hourly XP",
    icon: "fas fa-star",
    activeTool: "grantNow",
    tools: [
      {
        name: "grantNow",
        title: "Grant XP now",
        icon: "fas fa-gift",
        button: true,
        onClick: () => grantNow(),
      },
      {
        name: "start",
        title: "Start timer",
        icon: "fas fa-play",
        button: true,
        onClick: () => startTimer(),
      },
      {
        name: "stop",
        title: "Stop timer",
        icon: "fas fa-stop",
        button: true,
        onClick: () => stopTimer(),
      },
    ],
  });
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

  const api = { start: startTimer, stop: () => stopTimer(), grantNow, status };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  // Also expose globally for macro convenience.
  globalThis.HourlyXP = api;
});

Hooks.once("ready", () => {
  if (game.settings.get(MODULE_ID, "autoStart")) startTimer();
});
