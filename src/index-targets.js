import baseBackend, { AuthSession, FactionRoom } from "./index.js";
import { DurableObject } from "cloudflare:workers";

export { AuthSession, FactionRoom };

const TARGET_TRIAL_VERSION = "0.5.0";
const TARGET_CALL_TTL_MS = 4 * 60 * 60 * 1000;
const TARGET_STATE_KEY = "target_calls_v1";

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
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    }),
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

function cleanText(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function randomSafeId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : 0;
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

async function resolveAuth(env, token) {
  if (!/^[a-f0-9]{64}$/i.test(token || "")) return null;
  const id = env.AUTH_SESSIONS.idFromName(token);
  const stub = env.AUTH_SESSIONS.get(id);
  const response = await stub.fetch("https://auth/resolve");
  if (!response.ok) return null;
  const data = await response.json();
  return data?.ok ? data.auth : null;
}

async function getQueueState(env, auth) {
  const roomId = env.FACTION_ROOMS.idFromName(String(auth.faction_id));
  const roomStub = env.FACTION_ROOMS.get(roomId);
  const headers = new Headers();
  headers.set("X-Chain-Auth", encodeURIComponent(JSON.stringify(auth)));

  const response = await roomStub.fetch("https://room/http-state", {
    method: "GET",
    headers,
  });

  if (!response.ok) return null;
  return response.json();
}

async function routeTargetRoom(env, auth, path, request) {
  const id = env.TARGET_CALLS.idFromName(String(auth.faction_id));
  const stub = env.TARGET_CALLS.get(id);
  const headers = new Headers(request.headers);
  headers.set("X-Target-Auth", encodeURIComponent(JSON.stringify(auth)));

  return stub.fetch(`https://targets${path}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });
}

function targetAuthFromRequest(request) {
  const encoded = request.headers.get("X-Target-Auth") || "";
  try {
    const auth = JSON.parse(decodeURIComponent(encoded));
    return auth?.user_id && auth?.faction_id ? auth : null;
  } catch {
    return null;
  }
}

function normalizeCalls(raw) {
  const now = Date.now();
  const source = Array.isArray(raw) ? raw : [];
  return source
    .filter((call) => call && typeof call === "object")
    .map((call) => ({
      caller_user_id: randomSafeId(call.caller_user_id),
      caller_user_name: cleanText(call.caller_user_name, 64),
      target_id: randomSafeId(call.target_id),
      target_name: cleanText(call.target_name, 64),
      ff_value: finiteNumber(call.ff_value, null),
      est_value: finiteNumber(call.est_value, null),
      called_at_ms: Math.max(0, Number(call.called_at_ms || 0)),
    }))
    .filter((call) =>
      call.caller_user_id &&
      call.target_id &&
      call.called_at_ms > 0 &&
      now - call.called_at_ms <= TARGET_CALL_TTL_MS
    );
}

export class TargetCalls extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.cache = null;
  }

  async loadCalls() {
    if (this.cache) {
      const fresh = normalizeCalls(this.cache);
      if (fresh.length !== this.cache.length) {
        this.cache = fresh;
        await this.ctx.storage.put(TARGET_STATE_KEY, fresh);
      }
      return this.cache;
    }

    const stored = await this.ctx.storage.get(TARGET_STATE_KEY);
    this.cache = normalizeCalls(stored);
    return this.cache;
  }

  async saveCalls(calls) {
    this.cache = normalizeCalls(calls);
    await this.ctx.storage.put(TARGET_STATE_KEY, this.cache);
    return this.cache;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const auth = targetAuthFromRequest(request);
    if (!auth) return json({ ok: false, error: "Invalid session" }, 401);

    let calls = await this.loadCalls();

    if (request.method === "GET" && url.pathname === "/state") {
      return json({ ok: true, calls, server_time: Math.floor(Date.now() / 1000) });
    }

    if (request.method === "POST" && url.pathname === "/call") {
      const body = await readJson(request);
      const targetId = randomSafeId(body.target_id);
      const targetName = cleanText(body.target_name || `#${targetId}`, 64);

      if (!targetId) return json({ ok: false, error: "Invalid target" }, 400);
      if (targetId === Number(auth.user_id)) {
        return json({ ok: false, error: "You cannot call yourself" }, 400);
      }

      const taken = calls.find((call) =>
        Number(call.target_id) === targetId &&
        Number(call.caller_user_id) !== Number(auth.user_id)
      );

      if (taken) {
        return json({
          ok: false,
          error: `Target already called by ${taken.caller_user_name || `#${taken.caller_user_id}`}`,
          call: taken,
        }, 409);
      }

      calls = calls.filter((call) => Number(call.caller_user_id) !== Number(auth.user_id));
      calls.push({
        caller_user_id: Number(auth.user_id),
        caller_user_name: cleanText(auth.user_name || `#${auth.user_id}`, 64),
        target_id: targetId,
        target_name: targetName,
        ff_value: finiteNumber(body.ff_value, null),
        est_value: finiteNumber(body.est_value, null),
        called_at_ms: Date.now(),
      });

      calls = await this.saveCalls(calls);
      const call = calls.find((item) => Number(item.caller_user_id) === Number(auth.user_id)) || null;
      return json({ ok: true, calls, call, server_time: Math.floor(Date.now() / 1000) });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const before = calls.length;
      calls = calls.filter((call) => Number(call.caller_user_id) !== Number(auth.user_id));
      if (calls.length !== before) calls = await this.saveCalls(calls);
      return json({ ok: true, calls, server_time: Math.floor(Date.now() / 1000) });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
}

async function authenticatedTargetRequest(request, env, pathname) {
  const authHeader = String(request.headers.get("Authorization") || "");
  const tokenMatch = authHeader.match(/^Bearer\s+([A-Fa-f0-9]{64})$/);
  const token = tokenMatch ? tokenMatch[1] : "";
  const auth = await resolveAuth(env, token);

  if (!auth) return json({ ok: false, error: "Session expired" }, 401);
  if (!isFactionAllowed(env, auth.faction_id)) {
    return json({ ok: false, error: "Your faction is not authorised to use this Chain Manager" }, 403);
  }

  if (request.method === "POST" && pathname === "/api/v1/targets/call") {
    const queueState = await getQueueState(env, auth);
    if (!queueState?.viewer?.joined) {
      return json({ ok: false, error: "Join the Chain Manager queue before calling a target" }, 409);
    }
  }

  const targetPath =
    pathname === "/api/v1/targets" ? "/state" :
    pathname === "/api/v1/targets/call" ? "/call" :
    pathname === "/api/v1/targets/release" ? "/release" :
    "";

  if (!targetPath) return json({ ok: false, error: "Not found" }, 404);
  return routeTargetRoom(env, auth, targetPath, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (
      (request.method === "GET" && url.pathname === "/api/v1/targets") ||
      (request.method === "POST" && url.pathname === "/api/v1/targets/call") ||
      (request.method === "POST" && url.pathname === "/api/v1/targets/release")
    ) {
      return authenticatedTargetRequest(request, env, url.pathname);
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/v1/health")
    ) {
      const response = await baseBackend.fetch(request, env);
      try {
        const data = await response.json();
        return json({
          ...data,
          version: TARGET_TRIAL_VERSION,
          queue_backend_version: data?.version || null,
          target_calls: true,
          target_call_ttl_hours: TARGET_CALL_TTL_MS / 3600000,
        }, response.status);
      } catch {
        return response;
      }
    }

    return baseBackend.fetch(request, env);
  },
};
