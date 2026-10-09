/**
 * Hourly XP — Foundry VTT module
 * Automatically grants XP to every player-owned character on a repeating
 * real-time timer. Designed for 24-hour marathon sessions.
 *
 * The timer runs only on the active GM's client, so it never double-grants.
 * If Foundry (or the GM's browser) restarts, restart the timer with the
 * macro API below or enable "Auto-start on ready" in module settings.
 *
 * XP is awarded through the WFRP4e system's native awardExp, so the XP log
 * gets a proper entry and the system's per-actor reason dialog never pops.
 * Manual grants ask for the reason ONCE, then apply it to everyone;
 * automatic timer ticks log the default reason silently.
 *
 * The GM's character roster doubles as a DM dashboard: live countdown to
 * the next XP drop, XP granted this session vs. all-time, and a rough
 * power tier per character (plus the party average) based on total XP.
 *
 * Every timer tick is a little ceremony: a radiant golden aura flares
 * around each granted character's tokens and chat proclaims one of a
 * rotating pool of Sigmar's blessings. The Donation FX panel (toolbar or
 * macro) fires one-click visual effects for every item on the charity
 * donation-incentives list — player boons, GM chaos, and milestones —
 * including a real 4-hour DOUBLE XP multiplier.
 *
 * Macro API (run as GM):
 *   game.modules.get("hourly-xp").api.start();     // start the timer
 *   game.modules.get("hourly-xp").api.stop();      // stop the timer
 *   game.modules.get("hourly-xp").api.grantNow();   // manual grant (one reason prompt)
 *   game.modules.get("hourly-xp").api.status();    // running? ticks? next in? granted? 2x?
 *   game.modules.get("hourly-xp").api.roster();    // open the character roster
 *   game.modules.get("hourly-xp").api.fx("crit", "Zelp"); // donation FX, optional target name
 *   game.modules.get("hourly-xp").api.fxList();    // all FX keys, labels, prices
 *   game.modules.get("hourly-xp").api.fxPanel();   // open the Donation FX panel
 *
 * A GM-only toolbar button (star icon, left toolbar) exposes the character
 * roster, Grant Now, Start, and Stop without touching the console.
 */

const MODULE_ID = "hourly-xp";

let xpTimer = null;
let tickCount = 0;
let lastTickAt = 0;
let sessionGranted = 0; // XP granted by this module since the timer was (re)started

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

/** Default reason recorded in the XP log (setting; pre-fills the manual prompt). */
function defaultReason() {
  const r = String(game.settings.get(MODULE_ID, "defaultReason") ?? "");
  return r.trim() || "Hourly XP";
}

/* ------------------------------------------------------------------ */
/* DM dashboard: totals, countdown, tiers                              */
/* ------------------------------------------------------------------ */

/** All-time XP granted by this module (world setting, survives restarts). */
function getTotalGranted() {
  return Number(game.settings.get(MODULE_ID, "totalGranted")) || 0;
}

/** Record a grant of `amount` XP to `count` characters. */
async function recordGrant(amount, count) {
  const gained = amount * count;
  if (gained <= 0) return;
  sessionGranted += gained;
  await game.settings.set(MODULE_ID, "totalGranted", getTotalGranted() + gained);
}

/**
 * Rough power tier from a character's total XP earned. WFRP4e has no
 * official tier brackets, so treat these as a DM's at-a-glance guide:
 * a starting character sits near 0, and ~100 XP/hour puts the party
 * around Heroic by the back half of a 24-hour marathon.
 */
const XP_TIERS = [
  { min: 2000, label: "Legendary" },
  { min: 1000, label: "Heroic" },
  { min: 500, label: "Veteran" },
  { min: 200, label: "Seasoned" },
  { min: 0, label: "Novice" },
];

function xpTier(total) {
  for (const t of XP_TIERS) if (total >= t.min) return t.label;
  return "Novice";
}

/** Seconds until the next tick, or null when the timer is stopped. */
function nextTickInSeconds() {
  if (!xpTimer) return null;
  const minutes = Number(game.settings.get(MODULE_ID, "intervalMinutes")) || 60;
  return Math.max(0, Math.round((minutes * 60 * 1000 - (Date.now() - lastTickAt)) / 1000));
}

/** "1h 23m" / "4m 05s" / "37s" — null/undefined renders as an em dash. */
function fmtCountdown(sec) {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/* ------------------------------------------------------------------ */
/* Blessings & donation FX (visuals + flavor)                           */
/*                                                                     */
/* All visuals are vanilla Foundry: a radial-glow tile under each       */
/* affected token plus a brief golden tint pulse. No extra modules      */
/* needed; everything degrades gracefully with no canvas.               */
/* ------------------------------------------------------------------ */

/** Rotating pool of Sigmar's blessings, one proclaimed per timer tick. */
const BLESSINGS = [
  "Sigmar's blessing has been bestowed — you feel empowered!",
  "The light of the Twin-Tailed Comet falls upon you. Sigmar watches.",
  "By Sigmar's hammer, you grow stronger!",
  "Sigmar smiles upon the faithful — feel His strength surge through you!",
  "Sigmar, the God-King, turns His gaze to you. Power courses through your veins!",
  "A twin-tailed comet streaks across the heavens. Sigmar provides!",
  "Heldenhammer's blessing — Sigmar's own — settles upon your shoulders.",
  "Sigmar's wrath fuels you; His mercy sustains you. You feel empowered!",
];

function randomBlessing() {
  return BLESSINGS[Math.floor(Math.random() * BLESSINGS.length)];
}

/**
 * Donation-incentives FX table. `message` receives the target name(s).
 * Colors are "r,g,b" for the radial glow; size is in token-widths.
 */
const FX = {
  // -- Player incentives --
  reroll:      { cat: "Player", price: 5,  label: "Second Chance",     inner: "255,240,190", mid: "255,200,90",  size: 2.2, message: (t) => `Sigmar grants ${t} a second chance — reroll it!` },
  crit:        { cat: "Player", price: 10, label: "Blessed Crit",      inner: "255,255,230", mid: "255,215,110", size: 2.6, message: (t) => `Sigmar guides the blow — a critical strike for ${t}!` },
  extraAction: { cat: "Player", price: 15, label: "Divine Swiftness",  inner: "255,235,170", mid: "255,195,80",  size: 2.4, message: (t) => `${t} move with divine swiftness — an extra action!` },
  autoSuccess: { cat: "Player", price: 20, label: "Sigmar's Hand",     inner: "255,255,240", mid: "255,220,120", size: 2.8, message: (t) => `Sigmar's own hand steadies ${t} — automatic success!` },
  fatePoint:   { cat: "Player", price: 25, label: "Cheat Morr",        inner: "255,240,200", mid: "240,200,100", size: 2.6, message: (t) => `${t} snatch a Fate point back from Morr's grasp!` },
  blessParty:  { cat: "Player", price: 30, label: "Blessing of Sigmar",inner: "255,245,200", mid: "255,205,95",  size: 3.2, message: (t) => `The party is blessed by Sigmar!` },
  // -- GM chaos --
  intrusion:   { cat: "Chaos", price: 10, label: "GM Intrusion",       inner: "200,140,255", mid: "120,60,180",  size: 2.4, message: (t) => `The Ruinous Powers stir — a GM intrusion upon ${t}!` },
  fumbleCurse: { cat: "Chaos", price: 15, label: "Fumble Curse",       inner: "255,120,120", mid: "170,40,40",   size: 2.6, message: (t) => `Tzeentch cackles — ${t} are cursed to fumble!` },
  complication:{ cat: "Chaos", price: 20, label: "Cruel Complication", inner: "255,160,100", mid: "180,70,30",   size: 2.6, message: (t) => `Nothing goes to plan — a cruel complication strikes ${t}!` },
  betrayal:    { cat: "Chaos", price: 25, label: "Whisper of Betrayal",inner: "190,130,255", mid: "110,50,170",  size: 2.4, message: (t) => `A dark whisper curls around ${t}...` },
  ruinPlan:    { cat: "Chaos", price: 30, label: "Ruin the Plan",       inner: "210,150,255", mid: "100,40,160",  size: 3.0, message: (t) => `The GM's ruin-a-plan token is spent. Sigmar preserve ${t}...` },
  // -- Milestones --
  secretReveal:{ cat: "Milestone", price: 250,  label: "Hidden Truth", inner: "255,244,200", mid: "230,200,120", size: 2.4, message: () => `A hidden campaign secret is revealed!` },
  bonusBoss:   { cat: "Milestone", price: 500,  label: "Bonus Boss",    inner: "255,130,130", mid: "170,40,40",   size: 3.4, message: () => `A Chaos Spawn crashes into the fray!` },
  gmDice:      { cat: "Milestone", price: 750,  label: "Seize the Dice",inner: "255,240,190", mid: "255,200,90",  size: 2.6, message: () => `The players seize the GM's dice for an entire act!` },
  chaosHour:   { cat: "Milestone", price: 1000, label: "CHAOS HOUR",    inner: "255,150,150", mid: "140,50,150",  size: 3.6, message: () => `CHAOS HOUR begins! Every hour, a manifestation!` },
  magicItem:   { cat: "Milestone", price: 1250, label: "Chat Forges",   inner: "255,242,200", mid: "240,200,110", size: 2.8, message: () => `Chat designs a magic item — the GM stats it on the spot!` },
  doubleXp:    { cat: "Milestone", price: 1500, label: "DOUBLE XP",      inner: "255,250,210", mid: "255,210,100", size: 3.4, message: () => `DOUBLE XP for the next 4 hours!`,
                 run: async () => { doubleXpUntil = Date.now() + 4 * 3600 * 1000; } },
  fateRefresh: { cat: "Milestone", price: 1750, label: "Fate Restored", inner: "255,240,200", mid: "240,200,110", size: 3.0, message: () => `The party's Fate points are restored!` },
  finaleWish:  { cat: "Milestone", price: 2000, label: "Finale Wish",   inner: "255,255,245", mid: "255,225,130", size: 4.0, message: () => `The $2,000 finale wish is granted!` },
};

/** List every FX key with its label, category, and price (for macros/panels). */
function fxList() {
  return Object.entries(FX).map(([key, d]) => ({ key, label: d.label, cat: d.cat, price: d.price }));
}

/** DOUBLE XP state: timestamp (ms) until which ticks grant double. */
let doubleXpUntil = 0;

function xpMultiplier() {
  return Date.now() < doubleXpUntil ? 2 : 1;
}

/** Cached radial-glow textures, keyed by color pair. */
const _texCache = {};

function glowTexture(inner, mid) {
  const key = `${inner}|${mid}`;
  if (_texCache[key]) return _texCache[key];
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
    g.addColorStop(0, `rgba(${inner},0.95)`);
    g.addColorStop(0.45, `rgba(${mid},0.5)`);
    g.addColorStop(1, `rgba(${mid},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    _texCache[key] = c.toDataURL();
    return _texCache[key];
  } catch (e) {
    return null;
  }
}

/**
 * Flare a radiant aura under each affected token plus a brief golden tint
 * pulse on the token itself. `actors` are granted actors; def carries the
 * FX colors/size. Skips cleanly with no canvas or when disabled.
 */
async function radiantAura(actors, def) {
  if (!game.settings.get(MODULE_ID, "celebrationFx")) return;
  const tex = glowTexture(def.inner, def.mid);
  const size = def.size || 2.4;
  const dur = 2500;
  const jobs = [];
  for (const actor of actors) {
    const tokens = typeof actor.getActiveTokens === "function" ? actor.getActiveTokens() : [];
    for (const token of tokens) {
      jobs.push(
        (async () => {
          try {
            const doc = token.document;
            const scene = doc?.parent;
            const tw = token.w ?? doc?.width ?? 100;
            const th = token.h ?? doc?.height ?? 100;
            const tx = token.x ?? doc?.x ?? 0;
            const ty = token.y ?? doc?.y ?? 0;
            let tile = null;
            if (tex && scene?.createEmbeddedDocuments) {
              const w = tw * size;
              const h = th * size;
              const docs = await scene.createEmbeddedDocuments("Tile", [
                { "texture.src": tex, x: tx - w / 2, y: ty - h / 2, width: w, height: h, alpha: 0.95 },
              ]);
              tile = docs?.[0] ?? null;
            }
            const origTint = doc?.texture?.tint;
            try {
              await doc?.update?.({ "texture.tint": 0xffd766 });
            } catch (e) { /* tint unsupported, aura tile is enough */ }
            setTimeout(async () => {
              try {
                await doc?.update?.({ "texture.tint": origTint ?? null });
              } catch (e) {}
              try {
                await tile?.delete();
              } catch (e) {}
            }, dur);
          } catch (e) { /* never let FX break a grant */ }
        })()
      );
    }
  }
  await Promise.allSettled(jobs);
}

/**
 * Resolve an FX target: actor name (case-insensitive, partial ok), actor id,
 * an actor, or an array of those. Blank/undefined targets the whole
 * unlocked roster. Returns { actors, names } for messaging.
 */
function resolveFxTargets(target) {
  const pool = unlockedRostered();
  if (target == null || (typeof target === "string" && !target.trim())) {
    return { actors: pool, names: "the party" };
  }
  const wants = (Array.isArray(target) ? target : [target]).map((t) =>
    typeof t === "string" ? t.trim().toLowerCase() : t
  );
  const actors = [];
  for (const w of wants) {
    if (typeof w !== "string") {
      if (w && pool.includes(w)) actors.push(w);
      continue;
    }
    const hit =
      pool.find((a) => a.id.toLowerCase() === w) ||
      pool.find((a) => a.name.toLowerCase() === w) ||
      pool.find((a) => a.name.toLowerCase().includes(w));
    if (hit && !actors.includes(hit)) actors.push(hit);
  }
  if (!actors.length) {
    ui.notifications?.warn(`Hourly XP: no rostered character matches "${target}".`);
  }
  return { actors, names: actors.map((a) => a.name).join(", ") || "the party" };
}

/**
 * Play a donation FX: radiant aura on the targets + a chat proclamation.
 * `target` is optional (name, id, actor, or array; blank = whole party).
 */
async function playFx(key, target) {
  const def = FX[key];
  if (!def) {
    ui.notifications?.warn(`Hourly XP: unknown effect "${key}".`);
    return false;
  }
  const { actors, names } = resolveFxTargets(target);
  if (def.run) await def.run(actors);
  await radiantAura(actors, def);
  if (def.message) announce(`<p><strong>${escHtml(def.label)}</strong> — ${escHtml(def.message(names))}</p>`);
  ui.notifications?.info(`Hourly XP: ${def.label} ($${def.price}).`);
  return true;
}

/** The tick blessing: golden aura on every granted actor + a random Sigmar proclamation. */
async function blessTick(actors, amount, count, tickNum, minutes) {
  await radiantAura(actors, { inner: "255,244,200", mid: "255,205,95", size: 2.8 });
  if (game.settings.get(MODULE_ID, "announceInChat")) {
    const mult = xpMultiplier();
    announce(
      `<p><strong>${randomBlessing()}</strong></p>` +
        `<p class="hint">Hourly XP — granted <strong>${amount} XP</strong> ` +
        `to ${count} character(s)${mult > 1 ? " (DOUBLE XP!)" : ""} ` +
        `(tick ${tickNum}, every ${minutes} min).</p>`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Donation FX panel (GM only)                                          */
/* ------------------------------------------------------------------ */

class XPFxPanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "hourly-xp-fx",
      title: "Hourly XP — Donation FX",
      width: 560,
      height: 560,
      resizable: true,
    });
  }

  getData() {
    const groups = {};
    for (const [key, d] of Object.entries(FX)) {
      (groups[d.cat] = groups[d.cat] || []).push({ key, label: d.label, price: d.price });
    }
    return { groups: Object.entries(groups), target: this.target || "" };
  }

  async _renderInner(data) {
    const sections = data.groups
      .map(
        ([cat, items]) => `
        <h3>${escHtml(cat)} incentives</h3>
        <div class="fx-grid">
          ${items
            .map(
              (it) => `<button type="button" class="fx-btn" data-fx="${it.key}">` +
                `${escHtml(it.label)} <span class="price">$${it.price}</span></button>`
            )
            .join("")}
        </div>`
      )
      .join("");
    return $(`
      <div class="hourly-xp-fx">
        <style>
          .hourly-xp-fx .fx-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
          .hourly-xp-fx .fx-btn { padding: 8px; cursor: pointer; }
          .hourly-xp-fx .fx-btn .price { opacity: 0.7; font-size: 0.85em; }
          .hourly-xp-fx h3 { margin: 8px 0 6px; border-bottom: 1px solid #555; }
          .hourly-xp-fx .target-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
          .hourly-xp-fx .target-row input { flex: 1; }
          .hourly-xp-fx .hint { opacity: 0.75; font-size: 0.85em; }
        </style>
        <div class="target-row">
          <label>Target</label>
          <input type="text" class="fx-target" placeholder="Character name — blank = whole party" value="${escHtml(data.target)}">
        </div>
        ${sections}
        <p class="hint">Player and Chaos effects target one character or the whole party. Milestones are party-wide.</p>
      </div>`);
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".fx-btn").on("click", async (ev) => {
      const key = ev.currentTarget.dataset.fx;
      const target = html.find(".fx-target").val()?.trim() || undefined;
      this.target = target;
      await playFx(key, target);
    });
  }
}

let fxPanelApp = null;

/** Open the Donation FX panel. */
function openFxPanel() {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Hourly XP: only the GM can open the FX panel.");
    return;
  }
  if (!fxPanelApp) fxPanelApp = new XPFxPanel();
  fxPanelApp.render(true);
}

/**
 * Award XP through the WFRP4e system's native awardExp: writes the XP log
 * entry with the given reason and does NOT pop the per-actor reason dialog.
 * Falls back to a raw update when awardExp is unavailable.
 */
async function awardXp(actor, amount, reason) {
  if (typeof actor.system?.awardExp === "function") {
    // suppressChat: our own announceInChat summary covers the chat message.
    await actor.system.awardExp(amount, reason, null, true);
    return;
  }
  if (typeof actor.awardExp === "function") {
    await actor.awardExp(amount, reason);
    return;
  }
  const { key, total } = readXp(actor);
  await actor.update({ [`system.details.experience.${key}`]: total + amount });
}

/** Unlocked, rostered player characters eligible for grants. */
function unlockedRostered() {
  const locked = getLocked();
  const excluded = getExcluded();
  return playerCharacters().filter((a) => !locked[a.id] && !excluded[a.id]);
}

/** Grant `amount` XP to every unlocked, rostered player character. Returns count granted. */
async function grantXpToAll(amount, reason) {
  let count = 0;
  for (const actor of unlockedRostered()) {
    await awardXp(actor, amount, reason);
    count++;
  }
  return count;
}

/** Grant `amount` XP to the given actor IDs (locked actors are skipped). Returns count granted. */
async function grantXpToIds(amount, ids, reason) {
  const wanted = new Set(ids);
  let count = 0;
  for (const actor of playerCharacters()) {
    if (wanted.has(actor.id) && !isLocked(actor.id)) {
      await awardXp(actor, amount, reason);
      count++;
    }
  }
  return count;
}

/**
 * Ask for the XP reason ONCE. Resolves to the reason string,
 * or null if the GM cancels.
 */
function promptReason(amount, count) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const preset = defaultReason();
    new Dialog({
      title: "Hourly XP — Grant XP",
      content:
        `<form><p>Granting <strong>${amount} XP</strong> to ` +
        `<strong>${count}</strong> character(s).</p>` +
        `<div class="form-group"><label>Reason</label>` +
        `<input type="text" name="reason" value="${escHtml(preset)}"></div></form>`,
      buttons: {
        grant: {
          icon: '<i class="fas fa-gift"></i>',
          label: "Grant",
          callback: (html) => finish(html.find('[name="reason"]').val()?.trim() || preset),
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => finish(null),
        },
      },
      default: "grant",
      close: () => finish(null),
    }).render(true);
  });
}

/**
 * Manual grant: a single reason prompt, then the award goes to every
 * target. Returns count granted.
 */
async function manualGrant(targets, amount) {
  if (!iAmActiveGM()) {
    ui.notifications?.warn("Hourly XP: only the active GM can grant XP.");
    return 0;
  }
  if (!targets.length) {
    ui.notifications?.warn("Hourly XP: no characters to grant XP to.");
    return 0;
  }
  const reason = await promptReason(amount, targets.length);
  if (reason == null) return 0; // cancelled
  let count = 0;
  for (const actor of targets) {
    await awardXp(actor, amount, reason);
    count++;
  }
  await recordGrant(amount, count);
  ui.notifications?.info(`Hourly XP: granted ${amount} XP to ${count} character(s).`);
  return count;
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
  sessionGranted = 0; // fresh timer run, fresh session counter
  xpTimer = setInterval(onTick, minutes * 60 * 1000);
  ui.notifications?.info(`Hourly XP started: ${amount} XP every ${minutes} minute(s).`);
  return true;
}

async function onTick() {
  if (!iAmActiveGM()) return; // GM changed mid-session; stay quiet
  const mult = xpMultiplier();
  const amount = xpPerTick() * mult;
  // Timer ticks never prompt: the default reason is logged silently.
  const targets = unlockedRostered();
  let count = 0;
  for (const actor of targets) {
    await awardXp(actor, amount, defaultReason());
    count++;
  }
  tickCount += 1;
  lastTickAt = Date.now();
  await recordGrant(amount, count);
  if (count > 0) {
    const minutes = game.settings.get(MODULE_ID, "intervalMinutes");
    await blessTick(targets, amount, count, tickCount, minutes);
  } else if (game.settings.get(MODULE_ID, "announceInChat")) {
    const minutes = game.settings.get(MODULE_ID, "intervalMinutes");
    announce(
      `<p class="hint">Hourly XP — tick ${tickCount}, no eligible characters (every ${minutes} min).</p>`
    );
  }
}

async function grantNow() {
  // Manual grant: one reason prompt, then award to everyone eligible.
  return manualGrant(unlockedRostered(), xpPerTick());
}

function status() {
  return {
    running: !!xpTimer,
    ticks: tickCount,
    nextTickInSeconds: nextTickInSeconds(),
    sessionGranted,
    totalGranted: getTotalGranted(),
    xpMultiplier: xpMultiplier(),
    doubleXpEndsInSeconds:
      doubleXpUntil > Date.now() ? Math.round((doubleXpUntil - Date.now()) / 1000) : null,
  };
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
      width: 720,
      height: 520,
      resizable: true,
    });
  }

  getData() {
    const locked = getLocked();
    const actors = rosterActors();
    const ids = new Set(actors.map((a) => a.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    const rows = actors.map((a) => {
      const { total, spent, available } = readXp(a);
      return {
        id: a.id,
        name: a.name,
        img: a.img,
        total,
        spent,
        available,
        tier: xpTier(total),
        locked: !!locked[a.id],
        selected: this.selected.has(a.id),
      };
    });
    const avgXp = rows.length
      ? Math.round(rows.reduce((sum, r) => sum + r.total, 0) / rows.length)
      : 0;
    return {
      rows,
      timerRunning: !!xpTimer,
      nextDrop: fmtCountdown(nextTickInSeconds()),
      sessionGranted,
      totalGranted: getTotalGranted(),
      avgXp,
      avgTier: xpTier(avgXp),
      doubleXp:
        doubleXpUntil > Date.now()
          ? `DOUBLE XP — ${fmtCountdown(Math.round((doubleXpUntil - Date.now()) / 1000))} left`
          : null,
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
          <td>${escHtml(r.tier)}</td>
          <td class="c"><button type="button" class="lock-btn" title="${
            r.locked ? "Unlock" : "Lock"
          }"><i class="fas fa-${r.locked ? "lock-open" : "lock"}"></i></button></td>
          <td class="c"><button type="button" class="remove-btn" title="Remove from roster"><i class="fas fa-times"></i></button></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="8" class="c">No player characters found.</td></tr>`;
    return $(`
      <div class="hourly-xp-roster">
        <style>
          .hourly-xp-roster table { width: 100%; border-collapse: collapse; }
          .hourly-xp-roster th, .hourly-xp-roster td { padding: 4px 6px; border-bottom: 1px solid #555; text-align: left; }
          .hourly-xp-roster td.n, .hourly-xp-roster th.n { text-align: right; font-variant-numeric: tabular-nums; }
          .hourly-xp-roster td.c, .hourly-xp-roster th.c { text-align: center; }
          .hourly-xp-roster .actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
          .hourly-xp-roster .hint { opacity: 0.75; font-size: 0.85em; }
          .hourly-xp-roster .statusbar { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 8px; padding: 6px 8px; border: 1px solid #555; border-radius: 4px; }
          .hourly-xp-roster .statusbar b { font-variant-numeric: tabular-nums; }
        </style>
        <div class="statusbar">
          <span>Next XP drop: <b class="next-drop">${escHtml(data.nextDrop)}</b>${data.timerRunning ? "" : ' <span class="hint">(timer stopped)</span>'}</span>
          <span>Session: <b>${data.sessionGranted} XP</b></span>
          <span>All-time: <b>${data.totalGranted} XP</b></span>
          <span>Party tier: <b>${escHtml(data.avgTier)}</b> <span class="hint">(avg ${data.avgXp} XP)</span></span>
          ${data.doubleXp ? `<span><b style="color:#ffd766">${escHtml(data.doubleXp)}</b></span>` : ""}
        </div>
        <table>
          <thead><tr><th class="c">Select</th><th>Character</th><th class="n">Total XP</th><th class="n">Spent XP</th><th class="n">Available</th><th>Tier</th><th class="c">Lock</th><th class="c">Remove</th></tr></thead>
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
    // Live countdown: refresh the "next drop" readout every second.
    if (this._cdInt) clearInterval(this._cdInt);
    this._cdInt = setInterval(() => {
      const el = this.element?.find(".next-drop");
      if (el?.length) el.text(fmtCountdown(nextTickInSeconds()));
      else clearInterval(this._cdInt);
    }, 1000);
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
      const ids = [...this.selected].filter((id) => !isLocked(id));
      const targets = playerCharacters().filter((a) => ids.includes(a.id));
      await manualGrant(targets, xpPerTick());
      this.render();
    });
    html.find(".grant-all").on("click", async () => {
      await manualGrant(unlockedRostered(), xpPerTick());
      this.render();
    });
    html.find(".restore").on("click", async () => {
      await restoreExcluded();
      this.render();
    });
  }

  async close(options) {
    if (this._cdInt) {
      clearInterval(this._cdInt);
      this._cdInt = null;
    }
    return super.close(options);
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
    { name: "fx", title: "Donation FX", icon: "fas fa-wand-magic-sparkles", action: () => openFxPanel() },
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

  game.settings.register(MODULE_ID, "defaultReason", {
    name: "Default XP reason",
    hint: "Reason written to the XP log for automatic timer grants, and pre-filled in the manual grant prompt.",
    scope: "world",
    config: true,
    type: String,
    default: "Hourly XP",
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

  game.settings.register(MODULE_ID, "totalGranted", {
    name: "Total XP granted (all-time)",
    hint: "Running total of XP this module has granted. Shown in the roster dashboard; reset by setting it to 0.",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
  });

  game.settings.register(MODULE_ID, "celebrationFx", {
    name: "Celebration visuals",
    hint: "Flare a radiant aura around each character's tokens (plus a brief golden tint pulse) when XP drops and donation FX fire. No extra modules needed.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "excludedActors", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });

  const api = { start: startTimer, stop: () => stopTimer(), grantNow, status, roster: openRoster,
    fx: playFx, fxList, fxPanel: openFxPanel };
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
