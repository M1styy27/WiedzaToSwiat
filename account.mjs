// Konto użytkownika: sam nick + hasło (bez e-maila), dane w Supabase.
// Wszystkie operacje na bazie idą przez ten plik z kluczem "secret" trzymanym w Netlify.
import { scrypt, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SECRET_KEY;
const SECRET = process.env.SESSION_SECRET;

const TOKEN_DAYS = 60;
const MAX_FAILS = 5;
const LOCK_MINUTES = 5;
const NICK_RE = /^[\p{L}\p{N}_.-]{3,20}$/u;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/* ---------- Supabase (REST) ---------- */

async function sb(path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: SB_KEY, "content-type": "application/json" };
  if (SB_KEY.startsWith("eyJ")) headers.authorization = "Bearer " + SB_KEY; // klucz w starym formacie (JWT)
  if (prefer) headers.prefer = prefer;
  const r = await fetch(SB_URL.replace(/\/$/, "") + "/rest/v1/" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) {
    const err = new Error("Supabase " + r.status);
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  return data;
}

async function findByNick(nick) {
  const rows = await sb("users?nick_lower=eq." + encodeURIComponent(nick.toLowerCase()) + "&select=*&limit=1");
  return rows && rows[0] ? rows[0] : null;
}

async function findById(id) {
  const rows = await sb("users?id=eq." + encodeURIComponent(id) + "&select=*&limit=1");
  return rows && rows[0] ? rows[0] : null;
}

/* ---------- hasła i sesje ---------- */

async function hashPassword(password, salt) {
  return (await scryptAsync(password, salt, 64)).toString("hex");
}

function hmac(data) {
  return createHmac("sha256", SECRET).update(data).digest("base64url");
}

function signToken(uid) {
  const payload = Buffer.from(JSON.stringify({ u: uid, e: Date.now() + TOKEN_DAYS * 864e5 })).toString("base64url");
  return payload + "." + hmac(payload);
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.u || !data.e || data.e < Date.now()) return null;
    return data.u;
  } catch (e) {
    return null;
  }
}

function userIdFromRequest(req) {
  const h = req.headers.get("authorization") || "";
  return verifyToken(h.replace(/^Bearer\s+/i, ""));
}

/* ---------- walidacja ---------- */

function cleanAvatar(a) {
  const emoji = a && typeof a.emoji === "string" && [...a.emoji].length >= 1 && [...a.emoji].length <= 6 ? a.emoji : "🙂";
  const color = a && typeof a.color === "string" && COLOR_RE.test(a.color) ? a.color : "#475569";
  return { emoji, color };
}

function cleanProgress(p) {
  if (!p || typeof p !== "object" || !p.done || typeof p.done !== "object" || !p.streak || typeof p.streak !== "object") return null;
  const done = {};
  let n = 0;
  for (const [k, v] of Object.entries(p.done)) {
    if (n++ > 2000) break;
    if (typeof k !== "string" || k.length > 200 || !v || typeof v !== "object") continue;
    done[k] = {
      score: Number(v.score) || 0,
      total: Number(v.total) || 0,
      at: String(v.at || "").slice(0, 10),
    };
  }
  return {
    done,
    streak: {
      last: String(p.streak.last || "").slice(0, 10),
      count: Math.max(0, Math.min(100000, Number(p.streak.count) || 0)),
    },
  };
}

const publicUser = (u) => ({ id: u.id, nick: u.nick, avatar: u.avatar });

/* ---------- akcje ---------- */

async function register(body) {
  const nick = String(body.nick || "").trim();
  const password = String(body.password || "");
  if (!NICK_RE.test(nick)) return json({ error: "Nick ma 3-20 znaków: litery, cyfry, _ . lub -." }, 400);
  if (password.length < 8 || password.length > 72) return json({ error: "Hasło musi mieć od 8 do 72 znaków." }, 400);

  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);
  let rows;
  try {
    rows = await sb("users", {
      method: "POST",
      prefer: "return=representation",
      body: {
        nick,
        nick_lower: nick.toLowerCase(),
        pass_salt: salt,
        pass_hash: hash,
        avatar: cleanAvatar(body.avatar),
      },
    });
  } catch (e) {
    if (e.detail && e.detail.code === "23505") return json({ error: "Ten nick jest już zajęty." }, 409);
    throw e;
  }
  const u = rows[0];
  return json({ token: signToken(u.id), user: publicUser(u), progress: u.progress });
}

async function login(body) {
  const nick = String(body.nick || "").trim();
  const password = String(body.password || "");
  const bad = () => json({ error: "Nieprawidłowy nick lub hasło." }, 401);
  if (!NICK_RE.test(nick) || !password || password.length > 72) return bad();

  const u = await findByNick(nick);
  if (!u) {
    await hashPassword(password, "0".repeat(32)); // wyrównanie czasu odpowiedzi
    return bad();
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return json({ error: "Zbyt wiele nieudanych prób. Spróbuj za kilka minut." }, 429);
  }

  const hash = await hashPassword(password, u.pass_salt);
  const ok = timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(u.pass_hash, "hex"));
  if (!ok) {
    const count = (u.failed_count || 0) + 1;
    const patch = count >= MAX_FAILS
      ? { failed_count: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() }
      : { failed_count: count };
    await sb("users?id=eq." + u.id, { method: "PATCH", body: patch });
    return bad();
  }
  if (u.failed_count || u.locked_until) {
    await sb("users?id=eq." + u.id, { method: "PATCH", body: { failed_count: 0, locked_until: null } });
  }
  return json({ token: signToken(u.id), user: publicUser(u), progress: u.progress });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Metoda niedozwolona" }, 405);
  if (!SB_URL || !SB_KEY || !SECRET || SECRET.length < 32) {
    return json({ error: "Konto jest chwilowo niedostępne (brak konfiguracji serwera)." }, 503);
  }

  let body;
  try {
    const text = await req.text();
    if (text.length > 200000) return json({ error: "Za dużo danych." }, 413);
    body = JSON.parse(text);
  } catch (e) {
    return json({ error: "Zły format zapytania." }, 400);
  }

  try {
    switch (body.action) {
      case "register":
        return await register(body);
      case "login":
        return await login(body);
      case "me": {
        const uid = userIdFromRequest(req);
        if (!uid) return json({ error: "Sesja wygasła. Zaloguj się ponownie." }, 401);
        const u = await findById(uid);
        if (!u) return json({ error: "Sesja wygasła. Zaloguj się ponownie." }, 401);
        return json({ user: publicUser(u), progress: u.progress });
      }
      case "save": {
        const uid = userIdFromRequest(req);
        if (!uid) return json({ error: "Brak sesji." }, 401);
        const progress = cleanProgress(body.progress);
        if (!progress) return json({ error: "Zły format postępów." }, 400);
        await sb("users?id=eq." + encodeURIComponent(uid), { method: "PATCH", body: { progress } });
        return json({ ok: true });
      }
      case "avatar": {
        const uid = userIdFromRequest(req);
        if (!uid) return json({ error: "Brak sesji." }, 401);
        const avatar = cleanAvatar(body.avatar);
        await sb("users?id=eq." + encodeURIComponent(uid), { method: "PATCH", body: { avatar } });
        return json({ avatar });
      }
      default:
        return json({ error: "Nieznana akcja." }, 400);
    }
  } catch (e) {
    console.error("account error:", e.message, e.detail ? JSON.stringify(e.detail) : "");
    return json({ error: "Błąd serwera. Spróbuj ponownie za chwilę." }, 500);
  }
};

export const config = { path: "/account" };
