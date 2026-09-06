import { DurableObject } from "cloudflare:workers";

const BACKEND_VERSION = "0.4.6";
const AUTH_TTL_SECONDS = 12 * 60 * 60;
const ROOM_KEY = "room_state";
const TARGET_CALL_TTL_MS = 4 * 60 * 60 * 1000;

// Cloudflare usage reporting. Analytics is cached so normal queue traffic does
// not create a matching Analytics API request. Defaults match Workers Free as
// of 2026-09; override with env vars if the account plan/limits change.
const USAGE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_DAILY_REQUEST_LIMIT = 100_000;
const DEFAULT_DO_DAILY_REQUEST_LIMIT = 100_000;

let usageCache = {
  key: "",
  expiresAt: 0,
  value: null,
  inFlight: null,
};

function positiveEnvInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function utcDateString(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnightIso(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0, 0, 0, 0
  );
  return new Date(next).toISOString();
}

function usageLevel(maxPercent) {
  const p = Number(maxPercent || 0);
  if (p >= 100) return "limit_reached";
  if (p >= 97) return "critical";
  if (p >= 90) return "high";
  if (p >= 75) return "watch";
  return "normal";
}

function conservationForLevel(level) {
  switch (level) {
    case "limit_reached":
      return { multiplier: 8, near_role_multiplier: 2.5 };
    case "critical":
      return { multiplier: 4, near_role_multiplier: 1.8 };
    case "high":
      return { multiplier: 2, near_role_multiplier: 1.35 };
    case "watch":
      return { multiplier: 1.35, near_role_multiplier: 1.15 };
    default:
      return { multiplier: 1, near_role_multiplier: 1 };
  }
}

function usageWarning(level) {
  switch (level) {
    case "limit_reached":
      return "Cloudflare daily usage appears to have reached a configured limit. Requests may be rejected until 00:00 UTC.";
    case "critical":
      return "Cloudflare usage is very high. Strong conservation mode is active; the service may stop if the daily limit is reached.";
    case "high":
      return "Cloudflare usage is high. Background traffic is being reduced automatically.";
    case "watch":
      return "Cloudflare usage is elevated. Light conservation mode is active.";
    default:
      return "";
  }
}

function metricUsage(requests, limit) {
  const used = Math.max(0, Math.trunc(Number(requests || 0)));
  const max = Math.max(1, Math.trunc(Number(limit || 1)));
  const percent = Math.max(0, (used / max) * 100);
  return {
    requests: used,
    limit: max,
    remaining: Math.max(0, max - used),
    percent: Math.round(percent * 10) / 10,
  };
}

function sumGraphqlRequests(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => {
    const value = Number(row?.sum?.requests || 0);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function unconfiguredUsage(env, reason = "Cloudflare Analytics credentials are not configured") {
  const workerLimit = positiveEnvInt(
    env.WORKER_DAILY_REQUEST_LIMIT,
    DEFAULT_WORKER_DAILY_REQUEST_LIMIT
  );
  const doLimit = positiveEnvInt(
    env.DO_DAILY_REQUEST_LIMIT,
    DEFAULT_DO_DAILY_REQUEST_LIMIT
  );

  const accountIdPresent = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim().length > 0;
  const analyticsTokenPresent = String(env.CLOUDFLARE_ANALYTICS_TOKEN || "").trim().length > 0;
  const accountIdValid = /^[a-f0-9]{32}$/i.test(String(env.CLOUDFLARE_ACCOUNT_ID || "").trim());
  const analyticsTokenValidShape = String(env.CLOUDFLARE_ANALYTICS_TOKEN || "").trim().length >= 20;

  return {
    available: false,
    configured: false,
    source: "cloudflare-graphql",
    reason,
    credentials: {
      account_id_detected: accountIdPresent,
      account_id_valid_shape: accountIdValid,
      analytics_token_detected: analyticsTokenPresent,
      analytics_token_valid_shape: analyticsTokenValidShape,
    },
    generated_at: new Date().toISOString(),
    reset_at: nextUtcMidnightIso(),
    cache_seconds: Math.round(USAGE_CACHE_MS / 1000),
    analytics_may_lag: true,
    hard_stop: false,
    worker: metricUsage(0, workerLimit),
    durable_objects: metricUsage(0, doLimit),
    level: "unknown",
    conservation_multiplier: 1,
    near_role_multiplier: 1,
    warning: "",
  };
}

async function fetchCloudflareUsage(env) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const token = String(env.CLOUDFLARE_ANALYTICS_TOKEN || "").trim();

  if (!/^[a-f0-9]{32}$/i.test(accountId) || token.length < 20) {
    return unconfiguredUsage(env);
  }

  const now = Date.now();
  const startIso = `${utcDateString(now)}T00:00:00.000Z`;
  const endIso = new Date(now).toISOString();
  const yesterday = utcDateString(now - 24 * 60 * 60 * 1000);

  // workersInvocationsAdaptive is the dataset Cloudflare documents for Worker
  // request totals. durableObjectsInvocationsAdaptiveGroups is the documented
  // Durable Object requests dataset. We intentionally query ACCOUNT-WIDE totals
  // because the Free-plan quotas are account-wide, not just this script.
  const query = `
    {
      viewer {
        accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
          workersInvocationsAdaptive(
            limit: 10000,
            filter: {
              datetime_geq: ${JSON.stringify(startIso)},
              datetime_leq: ${JSON.stringify(endIso)}
            }
          ) {
            sum { requests }
          }
          durableObjectsInvocationsAdaptiveGroups(
            limit: 10000,
            filter: { date_gt: ${JSON.stringify(yesterday)} }
          ) {
            sum { requests }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  });

  let result = {};
  try {
    result = await response.json();
  } catch {
    throw new Error(`Cloudflare Analytics returned HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message = result?.errors?.[0]?.message || `Cloudflare Analytics HTTP ${response.status}`;
    throw new Error(message);
  }

  if (Array.isArray(result?.errors) && result.errors.length) {
    throw new Error(String(result.errors[0]?.message || "Cloudflare Analytics query failed"));
  }

  const account = result?.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("Cloudflare Analytics account not found");

  const workerRequests = sumGraphqlRequests(account.workersInvocationsAdaptive);
  const doRequests = sumGraphqlRequests(account.durableObjectsInvocationsAdaptiveGroups);

  const worker = metricUsage(
    workerRequests,
    positiveEnvInt(env.WORKER_DAILY_REQUEST_LIMIT, DEFAULT_WORKER_DAILY_REQUEST_LIMIT)
  );
  const durableObjects = metricUsage(
    doRequests,
    positiveEnvInt(env.DO_DAILY_REQUEST_LIMIT, DEFAULT_DO_DAILY_REQUEST_LIMIT)
  );

  const maxPercent = Math.max(worker.percent, durableObjects.percent);
  const level = usageLevel(maxPercent);
  const conservation = conservationForLevel(level);

  return {
    available: true,
    configured: true,
    source: "cloudflare-graphql",
    credentials: {
      account_id_detected: true,
      account_id_valid_shape: true,
      analytics_token_detected: true,
      analytics_token_valid_shape: true,
    },
    scope: "account-wide",
    generated_at: new Date().toISOString(),
    reset_at: nextUtcMidnightIso(),
    cache_seconds: Math.round(USAGE_CACHE_MS / 1000),
    analytics_may_lag: true,
    hard_stop: false,
    worker,
    durable_objects: durableObjects,
    max_percent: Math.round(maxPercent * 10) / 10,
    level,
    conservation_multiplier: conservation.multiplier,
    near_role_multiplier: conservation.near_role_multiplier,
    warning: usageWarning(level),
  };
}

async function getCloudflareUsage(env, force = false) {
  const key = [
    String(env.CLOUDFLARE_ACCOUNT_ID || ""),
    String(env.WORKER_DAILY_REQUEST_LIMIT || DEFAULT_WORKER_DAILY_REQUEST_LIMIT),
    String(env.DO_DAILY_REQUEST_LIMIT || DEFAULT_DO_DAILY_REQUEST_LIMIT),
    String(Boolean(env.CLOUDFLARE_ANALYTICS_TOKEN)),
  ].join("|");

  const now = Date.now();

  if (!force && usageCache.key === key && usageCache.value && now < usageCache.expiresAt) {
    return usageCache.value;
  }

  if (!force && usageCache.key === key && usageCache.inFlight) {
    return usageCache.inFlight;
  }

  usageCache.key = key;
  usageCache.inFlight = (async () => {
    try {
      const value = await fetchCloudflareUsage(env);
      usageCache.value = value;
      usageCache.expiresAt = Date.now() + USAGE_CACHE_MS;
      return value;
    } catch (error) {
      // Do not break Chain Manager because Cloudflare Analytics is temporarily
      // unavailable. Keep queue actions live and report the metrics problem.
      const fallbackBase = unconfiguredUsage(
        env,
        error?.message || "Cloudflare Analytics unavailable"
      );
      const fallback = {
        ...fallbackBase,
        available: false,
        configured: Boolean(
          fallbackBase?.credentials?.account_id_detected &&
          fallbackBase?.credentials?.analytics_token_detected
        ),
        level: "unknown",
      };
      usageCache.value = fallback;
      // Retry a failed analytics lookup sooner than a healthy one.
      usageCache.expiresAt = Date.now() + 60_000;
      return fallback;
    } finally {
      usageCache.inFlight = null;
    }
  })();

  return usageCache.inFlight;
}

async function enrichJsonResponseWithUsage(response, env) {
  if (!response || response.status === 101) return response;

  const contentType = String(response.headers.get("Content-Type") || "");
  if (!contentType.includes("application/json")) return response;

  let data;
  try {
    data = await response.json();
  } catch {
    return response;
  }

  const cloudflareUsage = await getCloudflareUsage(env);

  return json(
    {
      ...data,
      cloudflare_usage: cloudflareUsage,
    },
    response.status,
    { "Cache-Control": "no-store" }
  );
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extra,
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8", ...extraHeaders }),
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sqlUtc(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function toMs(value) {
  if (!value) return 0;
  const text = String(value).includes("T") ? String(value) : String(value).replace(" ", "T") + "Z";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function allowedFactionIds(env) {
  const raw = String(env.ALLOWED_FACTION_IDS ?? env.ALLOWED_FACTION_ID ?? "").trim();
  if (!raw) return [];
  return [...new Set(
    raw
      .split(/[\s,;]+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
}

function isFactionAllowed(env, factionId) {
  const allowed = allowedFactionIds(env);
  return allowed.length === 0 || allowed.includes(Number(factionId));
}

async function tornJson(path, apiKey) {
  const response = await fetch(`https://api.torn.com/v2${path}${path.includes("?") ? "&" : "?"}comment=chain-manager`, {
    headers: {
      Authorization: `ApiKey ${apiKey}`,
      Accept: "application/json",
      "User-Agent": `DooBiiE-Chain-Manager/${BACKEND_VERSION}`,
    },
  });

  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data?.error) {
    const message = data?.error?.error || data?.error?.message || data?.message || `Torn API HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return data;
}

async function tornIdentity(apiKey) {
  const [keyInfoData, basicData] = await Promise.all([
    tornJson("/key/info", apiKey),
    tornJson("/user/basic", apiKey),
  ]);

  const keyInfo = keyInfoData?.info || keyInfoData?.key || keyInfoData || {};
  const keyUser = keyInfo?.user || keyInfoData?.user || {};
  const basic = basicData?.profile || basicData?.user || basicData || {};

  const userId = Number(
    keyUser?.id ?? keyUser?.user_id ??
    basic?.id ?? basic?.player_id ?? basic?.user_id ?? 0
  );
  const userName = String(basic?.name || keyUser?.name || "").trim();
  let factionId = Number(keyUser?.faction_id ?? keyInfo?.faction_id ?? 0);
  let factionName = "";

  if (!factionId) {
    try {
      const factionData = await tornJson("/user/faction", apiKey);
      const faction = factionData?.faction || factionData || {};
      factionId = Number(faction?.id ?? faction?.faction_id ?? 0);
      factionName = String(faction?.name ?? faction?.faction_name ?? "").trim();
    } catch {}
  }

  if (!userId || !userName) throw new Error("Could not identify the Torn player for this API key.");
  if (!factionId) throw new Error("This Torn player is not currently in a faction.");

  return {
    user_id: userId,
    user_name: userName,
    faction_id: factionId,
    faction_name: factionName || `Faction ${factionId}`,
  };
}

function normalizeTargetCalls(raw, now = Date.now()) {
  const source = Array.isArray(raw) ? raw : [];
  return source
    .filter((call) => call && typeof call === "object")
    .map((call) => {
      const callerUserId = Number(call.caller_user_id || 0);
      const targetId = Number(call.target_id || 0);
      const calledAtMs = Math.max(0, Number(call.called_at_ms || 0));
      const ff = call.ff_value == null ? null : Number(call.ff_value);
      const est = call.est_value == null ? null : Number(call.est_value);

      return {
        caller_user_id: Number.isInteger(callerUserId) && callerUserId > 0 ? callerUserId : 0,
        caller_user_name: String(call.caller_user_name || "").trim().slice(0, 64),
        target_id: Number.isInteger(targetId) && targetId > 0 ? targetId : 0,
        target_name: String(call.target_name || "").trim().slice(0, 64),
        ff_value: Number.isFinite(ff) ? ff : null,
        est_value: Number.isFinite(est) ? est : null,
        called_at_ms: calledAtMs,
      };
    })
    .filter((call) =>
      call.caller_user_id &&
      call.target_id &&
      call.called_at_ms > 0 &&
      now - call.called_at_ms <= TARGET_CALL_TTL_MS
    );
}

function clearTargetCallForUser(room, userId) {
  const before = Array.isArray(room.target_calls) ? room.target_calls.length : 0;
  room.target_calls = normalizeTargetCalls(room.target_calls)
    .filter((call) => Number(call.caller_user_id) !== Number(userId));
  return room.target_calls.length !== before;
}

function defaultRoom() {
  return {
    session: null,
    queue: [],
    processed_attack_ids: [],
    target_calls: [],
  };
}

function sanitizeRoom(raw) {
  if (!raw || typeof raw !== "object") return defaultRoom();
  return {
    session: raw.session && typeof raw.session === "object" ? raw.session : null,
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    processed_attack_ids: Array.isArray(raw.processed_attack_ids) ? raw.processed_attack_ids : [],
    target_calls: normalizeTargetCalls(raw.target_calls),
  };
}

function renumberQueue(room) {
  room.queue.forEach((member, index) => {
    member.queue_order = (index + 1) * 10;
  });
}

function findMember(room, userId) {
  return room.queue.find((member) => Number(member.user_id) === Number(userId)) || null;
}

function nextMemberId(room, currentUserId) {
  if (!room.queue.length) return null;
  const index = room.queue.findIndex((member) => Number(member.user_id) === Number(currentUserId));
  if (index < 0) return Number(room.queue[0].user_id);
  return Number(room.queue[(index + 1) % room.queue.length].user_id);
}


function cleanText(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}

function telemetryFromBody(body, existing = {}) {
  return {
    energy_current: clampInt(body.energy_current, 0, 100000, Number(existing.energy_current || 0)),
    energy_max: clampInt(body.energy_max, 0, 100000, Number(existing.energy_max || 0)),
    health_current: clampInt(body.health_current, 0, 1000000000, Number(existing.health_current || 0)),
    health_max: clampInt(body.health_max, 0, 1000000000, Number(existing.health_max || 0)),
    torn_status_state: cleanText(body.torn_status_state ?? existing.torn_status_state, 80),
    torn_status_description: cleanText(body.torn_status_description ?? existing.torn_status_description, 160),
    online_status: cleanText(body.online_status ?? existing.online_status, 40),
    online_relative: cleanText(body.online_relative ?? existing.online_relative, 80),
    last_action_timestamp: clampInt(body.last_action_timestamp, 0, 2147483647, Number(existing.last_action_timestamp || 0)),
  };
}

function telemetryChanged(member, next) {
  return Object.entries(next).some(([key, value]) => member[key] !== value);
}

function applyTelemetry(member, body) {
  const next = telemetryFromBody(body, member);
  const changed = telemetryChanged(member, next);
  Object.assign(member, next);
  return changed;
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    faction_id: Number(session.faction_id),
    faction_name: String(session.faction_name || ""),
    manager_user_id: session.manager_user_id == null ? null : Number(session.manager_user_id),
    active_user_id: session.active_user_id == null ? null : Number(session.active_user_id),
    hit_at_seconds: Number(session.hit_at_seconds || 180),
    chain_id: session.chain_id == null ? null : Number(session.chain_id),
    chain_current: Number(session.chain_current || 0),
    chain_max: Number(session.chain_max || 0),
    chain_timeout: Number(session.chain_timeout || 0),
    chain_snapshot_at: session.chain_snapshot_at || null,
    created_at: session.created_at || null,
  };
}

function payloadFor(room, auth) {
  const joined = Boolean(findMember(room, auth.user_id));
  const session = publicSession(room.session);
  return {
    session,
    queue: room.queue.map((member) => ({
      user_id: Number(member.user_id),
      user_name: String(member.user_name || ""),
      queue_order: Number(member.queue_order || 0),
      energy_current: Number(member.energy_current || 0),
      energy_max: Number(member.energy_max || 0),
      health_current: Number(member.health_current || 0),
      health_max: Number(member.health_max || 0),
      torn_status_state: String(member.torn_status_state || ""),
      torn_status_description: String(member.torn_status_description || ""),
      online_status: String(member.online_status || ""),
      online_relative: String(member.online_relative || ""),
      last_action_timestamp: Number(member.last_action_timestamp || 0),
      hits_completed: Number(member.hits_completed || 0),
      joined_at: member.joined_at || null,
      last_seen_at: member.last_seen_at || null,
    })),
    viewer: {
      user_id: Number(auth.user_id),
      joined,
      is_manager: Boolean(session && Number(session.manager_user_id) === Number(auth.user_id)),
      is_active: Boolean(session && Number(session.active_user_id) === Number(auth.user_id)),
    },
    target_calls: normalizeTargetCalls(room.target_calls),
    server_time: Math.floor(Date.now() / 1000),
  };
}

function errorObject(message, status = 400) {
  return { ok: false, error: String(message || "Request failed"), status };
}

export class AuthSession extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/create")) {
      const body = await readJson(request);
      const auth = body?.auth;
      if (!auth || !auth.user_id || !auth.faction_id) return json(errorObject("Invalid auth session"), 400);

      const expiresAt = Date.now() + AUTH_TTL_SECONDS * 1000;
      const record = { ...auth, expires_at: expiresAt };
      await this.ctx.storage.put("auth", record);
      await this.ctx.storage.setAlarm(expiresAt + 60_000);
      return json({ ok: true, expires_at: expiresAt });
    }

    if (request.method === "GET" && url.pathname.endsWith("/resolve")) {
      const auth = await this.ctx.storage.get("auth");
      if (!auth || Number(auth.expires_at || 0) <= Date.now()) {
        return json(errorObject("Session expired", 401), 401);
      }
      return json({ ok: true, auth });
    }

    return json(errorObject("Not found", 404), 404);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

// Cap on how long a PDA/HTTP long-poll request may be held open before the
// Durable Object answers anyway. Cloudflare's edge and most HTTP bridges
// (GM_xmlhttpRequest, PDA_httpGet) are comfortable well past this, but keep
// it conservative so a client's own request timeout never fires first.
const HTTP_LONG_POLL_MAX_WAIT_MS = 25_000;

export class FactionRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.roomCache = null;
    this.lastPersistAt = 0;
    // In-memory only - reset on eviction/restart. That's fine: worst case a
    // stale "since" value just gets an immediate reply instead of a held one,
    // which is harmless and self-corrects on the very next request.
    this.version = 0;
    this.waiters = new Set();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async loadRoom() {
    if (this.roomCache) return this.roomCache;
    this.roomCache = sanitizeRoom(await this.ctx.storage.get(ROOM_KEY));
    return this.roomCache;
  }

  async saveRoom(room) {
    this.roomCache = room;
    await this.ctx.storage.put(ROOM_KEY, room);
    this.lastPersistAt = Date.now();
  }

  // Called any time a mutation actually changes room state, from both the
  // HTTP/PDA action path and the WebSocket path. Wakes every HTTP long-poll
  // request currently held open on this Durable Object instance immediately,
  // regardless of which member's device is holding it - a mutation from any
  // member is relevant to everyone's queue view.
  bumpVersion() {
    this.version += 1;
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const wake of waiters) {
      try { wake(); } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const encoded = request.headers.get("X-Chain-Auth") || "";
    let auth;
    try {
      auth = JSON.parse(decodeURIComponent(encoded));
    } catch {
      return json(errorObject("Invalid session", 401), 401);
    }

    if (!auth?.user_id || !auth?.faction_id) {
      return json(errorObject("Invalid session", 401), 401);
    }

    // HTTP fallback for Torn PDA. Supports an optional long-poll: pass
    // ?since=<version>&wait=<ms> and this holds the response open (up to
    // HTTP_LONG_POLL_MAX_WAIT_MS) until either the room mutates past that
    // version or the wait elapses, instead of answering immediately every
    // time. A client that never sends since/wait gets the old immediate
    // behaviour, unchanged.
    if (request.method === "GET" && url.pathname === "/http-state") {
      const since = Number(url.searchParams.get("since"));
      const requestedWait = Number(url.searchParams.get("wait"));
      const waitMs = Number.isFinite(requestedWait)
        ? Math.min(HTTP_LONG_POLL_MAX_WAIT_MS, Math.max(0, requestedWait))
        : 0;

      if (waitMs > 0 && Number.isFinite(since) && since === this.version) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          this.waiters.add(() => { clearTimeout(timer); resolve(); });
        });
      }

      const room = await this.loadRoom();
      return json({ ok: true, version: this.version, ...payloadFor(room, auth) });
    }

    if (request.method === "POST" && url.pathname === "/http-action") {
      const body = await readJson(request);
      const action = String(body?.action || "state");
      let room = await this.loadRoom();

      try {
        const result = this.applyAction(room, auth, action, body);
        room = result.room;
        const mutated = result.mutated;
        // Falls back to mutated for every action that doesn't explicitly say
        // otherwise (only the heartbeat handler distinguishes telemetry-only
        // changes as non-urgent) - safe default, nothing else's behavior changes.
        const urgent = result.urgent ?? mutated;

        if (mutated) {
          this.roomCache = room;
          const persistNow = action !== "heartbeat" || Date.now() - this.lastPersistAt >= 120000;
          if (persistNow) await this.saveRoom(room);
          // WebSocket clients are cheap to push to regardless, so keep them
          // live on every change, including plain telemetry.
          await this.broadcastState(room);
        }
        // Only wake OTHER devices' held HTTP long-polls for a queue-relevant
        // change - not for every heartbeat's routine energy/health/status tick.
        if (urgent) this.bumpVersion();

        return json({ ok: true, version: this.version, ...payloadFor(room, auth) });
      } catch (error) {
        const status = Number(error?.status || 400);
        return json(errorObject(error?.message || String(error), status), status);
      }
    }

    // Realtime WebSocket path for desktop.
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return json(errorObject("WebSocket upgrade required", 426), 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(auth);

    const room = await this.loadRoom();
    server.send(JSON.stringify({ type: "state", ok: true, version: this.version, ...payloadFor(room, auth) }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcastState(room) {
    const textByUser = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const auth = ws.deserializeAttachment();
      if (!auth?.user_id) continue;
      const key = String(auth.user_id);
      let text = textByUser.get(key);
      if (!text) {
        text = JSON.stringify({ type: "state", ok: true, version: this.version, ...payloadFor(room, auth) });
        textByUser.set(key, text);
      }
      try { ws.send(text); } catch {}
    }
  }

  async webSocketMessage(ws, message) {
    const auth = ws.deserializeAttachment();
    if (!auth?.user_id || !auth?.faction_id) {
      try { ws.send(JSON.stringify({ type: "response", ok: false, error: "Invalid session" })); } catch {}
      return;
    }

    let requestData;
    try {
      requestData = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      try { ws.send(JSON.stringify({ type: "response", ok: false, error: "Invalid JSON" })); } catch {}
      return;
    }

    const requestId = String(requestData?.request_id || "");
    const action = String(requestData?.action || "state");
    const body = requestData && typeof requestData === "object" ? requestData : {};

    let room = await this.loadRoom();
    let mutated = false;

    try {
      const result = this.applyAction(room, auth, action, body);
      room = result.room;
      mutated = result.mutated;
      const urgent = result.urgent ?? mutated;

      if (mutated) {
        this.roomCache = room;
        const persistNow = action !== "heartbeat" || Date.now() - this.lastPersistAt >= 120000;
        if (persistNow) await this.saveRoom(room);
      }
      // Only wake PDA/HTTP long-poll waiters for a queue-relevant change, same
      // rule as the HTTP action path - not for every routine telemetry tick.
      if (urgent) this.bumpVersion();

      const response = {
        type: "response",
        request_id: requestId,
        ok: true,
        version: this.version,
        ...payloadFor(room, auth),
      };
      try { ws.send(JSON.stringify(response)); } catch {}

      // WS clients stay live on every change, including plain telemetry.
      if (mutated) await this.broadcastState(room);
    } catch (error) {
      const status = Number(error?.status || 400);
      try {
        ws.send(JSON.stringify({
          type: "response",
          request_id: requestId,
          ok: false,
          error: error?.message || String(error),
          status,
        }));
      } catch {}
    }
  }

  applyAction(room, auth, action, body) {
    const userId = Number(auth.user_id);
    const now = Date.now();
    const nowSql = sqlUtc(now);
    room.target_calls = normalizeTargetCalls(room.target_calls, now);
    const member = findMember(room, userId);

    const requireSession = () => {
      if (!room.session) {
        const err = new Error("No active chain queue");
        err.status = 409;
        throw err;
      }
      return room.session;
    };

    const requireManager = () => {
      const session = requireSession();
      if (Number(session.manager_user_id) !== userId) {
        const err = new Error("Manager permission required");
        err.status = 403;
        throw err;
      }
      return session;
    };

    if (action === "state") return { room, mutated: false };

    if (action === "join") {
      const telemetry = telemetryFromBody(body);

      if (!room.session) {
        room.session = {
          id: String(now),
          faction_id: Number(auth.faction_id),
          faction_name: String(auth.faction_name || ""),
          manager_user_id: userId,
          active_user_id: userId,
          hit_at_seconds: 180,
          chain_id: null,
          chain_current: 0,
          chain_max: 0,
          chain_timeout: 0,
          chain_snapshot_at: null,
          _chain_snapshot_ms: 0,
          created_at: nowSql,
        };
        room.processed_attack_ids = [];
      }

      const existing = findMember(room, userId);
      if (existing) {
        existing.user_name = String(auth.user_name || existing.user_name || "");
        Object.assign(existing, telemetry);
        existing.last_seen_at = nowSql;
      } else {
        room.queue.push({
          user_id: userId,
          user_name: String(auth.user_name || `#${userId}`),
          queue_order: (room.queue.length + 1) * 10,
          ...telemetry,
          hits_completed: 0,
          joined_at: nowSql,
          last_seen_at: nowSql,
        });
      }

      const chain = body.chain && typeof body.chain === "object" ? body.chain : null;
      if (chain) {
        room.session.chain_id = chain.id == null ? null : Number(chain.id);
        room.session.chain_current = clampInt(chain.current, 0, 100000000, 0);
        room.session.chain_max = clampInt(chain.max, 0, 100000000, 0);
        room.session.chain_timeout = clampInt(chain.timeout, 0, 36000, 0);
        room.session.chain_snapshot_at = nowSql;
        room.session._chain_snapshot_ms = now;
      }

      if (room.session.active_user_id == null) room.session.active_user_id = userId;
      if (room.session.manager_user_id == null) room.session.manager_user_id = userId;
      renumberQueue(room);
      return { room, mutated: true };
    }

    if (action === "call_target") {
      if (!room.session || !member) {
        const err = new Error("Join the Chain Manager queue before calling a target");
        err.status = 409;
        throw err;
      }

      const targetId = Number(body.target_id || 0);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        const err = new Error("Invalid target");
        err.status = 400;
        throw err;
      }
      if (targetId === userId) {
        const err = new Error("You cannot call yourself");
        err.status = 400;
        throw err;
      }

      const taken = room.target_calls.find((call) =>
        Number(call.target_id) === targetId &&
        Number(call.caller_user_id) !== userId
      );
      if (taken) {
        const err = new Error(
          `Target already called by ${taken.caller_user_name || `#${taken.caller_user_id}`}`
        );
        err.status = 409;
        throw err;
      }

      room.target_calls = room.target_calls.filter(
        (call) => Number(call.caller_user_id) !== userId
      );

      const ff = body.ff_value == null ? null : Number(body.ff_value);
      const est = body.est_value == null ? null : Number(body.est_value);

      room.target_calls.push({
        caller_user_id: userId,
        caller_user_name: String(auth.user_name || member.user_name || `#${userId}`).trim().slice(0, 64),
        target_id: targetId,
        target_name: String(body.target_name || `#${targetId}`).trim().slice(0, 64),
        ff_value: Number.isFinite(ff) ? ff : null,
        est_value: Number.isFinite(est) ? est : null,
        called_at_ms: now,
      });

      return { room, mutated: true, urgent: true };
    }

    if (action === "release_target") {
      const changed = clearTargetCallForUser(room, userId);
      return { room, mutated: changed, urgent: changed };
    }

    if (action === "leave") {
      if (!room.session || !member) return { room, mutated: false };

      clearTargetCallForUser(room, userId);

      const oldQueue = room.queue.slice();
      const oldIndex = oldQueue.findIndex((item) => Number(item.user_id) === userId);
      const wasActive = Number(room.session.active_user_id) === userId;
      const wasManager = Number(room.session.manager_user_id) === userId;
      room.queue = room.queue.filter((item) => Number(item.user_id) !== userId);

      if (!room.queue.length) {
        room = defaultRoom();
        return { room, mutated: true };
      }

      renumberQueue(room);
      if (wasActive) {
        const nextIndex = Math.max(0, oldIndex) % room.queue.length;
        room.session.active_user_id = Number(room.queue[nextIndex].user_id);
      }
      if (wasManager) room.session.manager_user_id = Number(room.queue[0].user_id);
      return { room, mutated: true };
    }

    if (action === "heartbeat") {
      const currentMember = findMember(room, userId);
      if (!room.session || !currentMember) return { room, mutated: false };

      const previousSeenMs = toMs(currentMember.last_seen_at);
      let mutated = applyTelemetry(currentMember, body);
      // Telemetry (energy/health/status ticking as it naturally does) is worth
      // saving so the next real poll sees it, but it is NOT worth waking every
      // other member's held long-poll request for - nobody needs an instant
      // push because someone's energy regenerated. Only an actual chain
      // change below is urgent.
      let urgent = false;

      // Persist a freshness heartbeat at most every two minutes even when values stay unchanged.
      if (mutated || now - previousSeenMs >= 120000) {
        currentMember.last_seen_at = nowSql;
        mutated = true;
      }

      const chain = body.chain && typeof body.chain === "object" ? body.chain : null;
      if (chain) {
        const chainId = chain.id == null ? null : Number(chain.id);
        const chainCurrent = clampInt(chain.current, 0, 100000000, 0);
        const chainMax = clampInt(chain.max, 0, 100000000, 0);
        const chainTimeout = clampInt(chain.timeout, 0, 36000, 0);
        const lastMs = Number(room.session._chain_snapshot_ms || 0);
        const previousTimeout = Number(room.session.chain_timeout || 0);
        const elapsedSinceSnapshot = lastMs > 0 ? Math.max(0, Math.floor((now - lastMs) / 1000)) : 0;
        const expectedRemaining = lastMs > 0 ? Math.max(0, previousTimeout - elapsedSinceSnapshot) : 0;
        // A successful chain hit resets Torn's timer upward. Detect that jump even
        // when hit_complete already updated chain_current before this heartbeat.
        const timerReset = lastMs > 0 && chainTimeout > expectedRemaining + 10;
        const chainChanged = chainId !== room.session.chain_id || chainCurrent !== Number(room.session.chain_current || 0) || chainMax !== Number(room.session.chain_max || 0) || timerReset;
        const refreshDue = now - lastMs >= 45000;

        if (chainChanged || refreshDue) {
          room.session.chain_id = chainId;
          room.session.chain_current = chainCurrent;
          room.session.chain_max = chainMax;
          room.session.chain_timeout = chainTimeout;
          room.session.chain_snapshot_at = nowSql;
          room.session._chain_snapshot_ms = now;
          mutated = true;
          // A routine 45s freshness resync with no real change isn't urgent
          // either - only an actual chain change (reset, new chain, etc) is.
          if (chainChanged) urgent = true;
        }
      }

      return { room, mutated, urgent };
    }

    if (action === "set_threshold") {
      const session = requireManager();
      session.hit_at_seconds = clampInt(body.seconds, 30, 290, 180);
      return { room, mutated: true };
    }

    if (action === "next") {
      const session = requireManager();
      const oldActiveUserId = Number(session.active_user_id || 0);
      if (oldActiveUserId) clearTargetCallForUser(room, oldActiveUserId);
      session.active_user_id = nextMemberId(room, session.active_user_id);
      return { room, mutated: true, urgent: true };
    }

    if (action === "transfer_manager") {
      const session = requireManager();
      const target = Number(body.target_user_id || 0);
      if (!target || !findMember(room, target)) {
        const err = new Error("New manager must be in the queue");
        err.status = 400;
        throw err;
      }
      session.manager_user_id = target;
      return { room, mutated: true };
    }

    if (action === "hit_complete") {
      const session = requireSession();
      if (Number(session.active_user_id) !== userId) {
        const err = new Error("You are not the active queue member");
        err.status = 409;
        throw err;
      }

      const attackId = String(body.attack_id || "").trim();
      if (!/^\d+$/.test(attackId)) {
        const err = new Error("Invalid attack id");
        err.status = 400;
        throw err;
      }

      if (room.processed_attack_ids.includes(attackId)) return { room, mutated: false };
      const currentMember = findMember(room, userId);
      if (!currentMember) {
        const err = new Error("You are not in the queue");
        err.status = 409;
        throw err;
      }

      room.processed_attack_ids.push(attackId);
      if (room.processed_attack_ids.length > 500) room.processed_attack_ids.splice(0, room.processed_attack_ids.length - 500);
      currentMember.hits_completed = Number(currentMember.hits_completed || 0) + 1;
      currentMember.last_seen_at = nowSql;

      const chainValue = Number(body.chain_value || 0);
      if (Number.isFinite(chainValue) && chainValue > Number(session.chain_current || 0)) {
        session.chain_current = Math.trunc(chainValue);
      }

      const defenderId = Number(body.defender_id || 0);
      if (defenderId > 0) {
        const ownCall = room.target_calls.find(
          (call) => Number(call.caller_user_id) === userId
        );
        if (ownCall && Number(ownCall.target_id) === defenderId) {
          clearTargetCallForUser(room, userId);
        }
      }

      session.active_user_id = nextMemberId(room, userId);
      return { room, mutated: true, urgent: true };
    }

    const err = new Error("Unknown action");
    err.status = 400;
    throw err;
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch {}
  }
}

async function routeRoomHttp(env, auth, path, request) {
  const roomId = env.FACTION_ROOMS.idFromName(String(auth.faction_id));
  const roomStub = env.FACTION_ROOMS.get(roomId);

  // Use a clean internal request rather than forwarding the browser's entire
  // outer header set into the Durable Object. Only the room auth and JSON
  // content metadata are needed internally.
  const headers = new Headers({
    "X-Chain-Auth": encodeURIComponent(JSON.stringify(auth)),
    "Accept": "application/json",
  });

  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  // Preserve the original query string. HTTP long-poll relies on
  // ?since=<version>&wait=<ms>.
  const incomingUrl = new URL(request.url);
  const roomUrl = new URL(`https://room${path}`);
  roomUrl.search = incomingUrl.search;

  // Buffer the small JSON action body before crossing the Worker -> Durable
  // Object boundary. Reusing the original incoming ReadableStream here was the
  // only transport difference between working Auth/State requests and the
  // failing PC Join POST path.
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text();
  }

  return roomStub.fetch(roomUrl.toString(), {
    method: request.method,
    headers,
    body: body === undefined ? undefined : body,
  });
}

async function resolveAuth(env, token) {
  if (!/^[a-f0-9]{64}$/i.test(token || "")) return null;
  const id = env.AUTH_SESSIONS.idFromName(token);
  const stub = env.AUTH_SESSIONS.get(id);
  const response = await stub.fetch("https://auth/resolve");
  if (!response.ok) return null;
  const data = await response.json();
  return data?.ok ? data.auth : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/v1/health")) {
      const cloudflareUsage = await getCloudflareUsage(env);
      return json({
        ok: true,
        service: "DooBiiE's Chain Manager backend",
        version: BACKEND_VERSION,
        transport: "Cloudflare Worker + Durable Objects + WebSocket Hibernation",
        restricted: allowedFactionIds(env).length > 0,
        allowed_faction_count: allowedFactionIds(env).length,
        cloudflare_usage: cloudflareUsage,
      }, 200, { "Cache-Control": "no-store" });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/auth") {
      const body = await readJson(request);
      const apiKey = String(body?.api_key || "").trim();
      if (apiKey.length < 8 || apiKey.length > 128) return json(errorObject("Invalid Torn API key", 400), 400);

      try {
        const auth = await tornIdentity(apiKey);
        if (!isFactionAllowed(env, auth.faction_id)) {
          return json(errorObject("Your faction is not authorised to use this Chain Manager", 403), 403);
        }

        const token = randomToken();
        const authId = env.AUTH_SESSIONS.idFromName(token);
        const authStub = env.AUTH_SESSIONS.get(authId);
        const created = await authStub.fetch("https://auth/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auth }),
        });
        if (!created.ok) return json(errorObject("Could not create login session", 500), 500);

        return json({
          ok: true,
          token,
          expires_in: AUTH_TTL_SECONDS,
          user: { id: auth.user_id, name: auth.user_name },
          faction: { id: auth.faction_id, name: auth.faction_name },
        });
      } catch (error) {
        return json(errorObject(error?.message || "Torn authentication failed", 401), 401);
      }
    }

    if ((request.method === "GET" && url.pathname === "/api/v1/state") ||
        (request.method === "POST" && url.pathname === "/api/v1/action")) {
      const authHeader = String(request.headers.get("Authorization") || "");
      const tokenMatch = authHeader.match(/^Bearer\s+([A-Fa-f0-9]{64})$/);
      const token = tokenMatch ? tokenMatch[1] : "";
      const auth = await resolveAuth(env, token);
      if (!auth) return json(errorObject("Session expired", 401), 401);

      if (!isFactionAllowed(env, auth.faction_id)) {
        return json(errorObject("Your faction is not authorised to use this Chain Manager", 403), 403);
      }

      const roomResponse = await routeRoomHttp(
        env,
        auth,
        url.pathname.endsWith("/state") ? "/http-state" : "/http-action",
        request
      );

      // Piggyback the cached account-wide Cloudflare usage onto the normal
      // state/action response so clients do not need a second polling endpoint.
      return enrichJsonResponseWithUsage(roomResponse, env);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/ws") {
      const token = String(url.searchParams.get("token") || "").trim();
      const auth = await resolveAuth(env, token);
      if (!auth) return json(errorObject("Session expired", 401), 401);

      if (!isFactionAllowed(env, auth.faction_id)) {
        return json(errorObject("Your faction is not authorised to use this Chain Manager", 403), 403);
      }

      const roomId = env.FACTION_ROOMS.idFromName(String(auth.faction_id));
      const roomStub = env.FACTION_ROOMS.get(roomId);
      const headers = new Headers(request.headers);
      headers.set("X-Chain-Auth", encodeURIComponent(JSON.stringify(auth)));
      return roomStub.fetch("https://room/ws", { headers });
    }

    return json(errorObject("Not found", 404), 404);
  },
};
