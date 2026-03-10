import { BrowserWindow, shell } from "electron";
import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { net } from "electron";

const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN ?? "";
const AUTH0_CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID ?? "";
function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://localhost:3001/v1";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL ?? "http://localhost:3001");
const CALLBACK_PORT = 17823;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}`;
const ACCESS_TOKEN_BUFFER_MS = 60_000;

interface AuthSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

let session: AuthSession | null = null;
let codeVerifier: string | null = null;
let callbackServer: Server | null = null;
let refreshInFlight: Promise<string | null> | null = null;
const authStateListeners = new Set<() => void>();

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function getAuthState() {
  return { isAuthenticated: session !== null };
}

function emitAuthStateChanged() {
  for (const listener of authStateListeners) {
    try {
      listener();
    } catch (err) {
      console.error("Auth state listener failed:", err);
    }
  }
}

function setSession(nextSession: AuthSession | null) {
  const previousToken = session?.accessToken ?? null;
  const nextToken = nextSession?.accessToken ?? null;
  const previousRefreshToken = session?.refreshToken ?? null;
  const nextRefreshToken = nextSession?.refreshToken ?? null;
  const previousExpiry = session?.expiresAt ?? null;
  const nextExpiry = nextSession?.expiresAt ?? null;

  session = nextSession;

  if (
    previousToken !== nextToken ||
    previousRefreshToken !== nextRefreshToken ||
    previousExpiry !== nextExpiry
  ) {
    emitAuthStateChanged();
  }
}

function clearSession() {
  refreshInFlight = null;
  setSession(null);
}

function expiresAtFromSeconds(expiresIn?: number): number | null {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return Date.now() + expiresIn * 1000;
}

function isSessionUsable(currentSession: AuthSession | null): currentSession is AuthSession {
  if (!currentSession) return false;
  if (currentSession.expiresAt === null) return true;
  return currentSession.expiresAt - ACCESS_TOKEN_BUFFER_MS > Date.now();
}

function applyTokenResponse(data: TokenResponse) {
  const previousSession = session;
  setSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previousSession?.refreshToken ?? null,
    expiresAt: expiresAtFromSeconds(data.expires_in),
  });
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await net.fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  return (await response.json()) as TokenResponse;
}

export function onAuthStateChanged(listener: () => void) {
  authStateListeners.add(listener);
  return () => {
    authStateListeners.delete(listener);
  };
}

export async function getValidAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null> {
  if (!options?.forceRefresh && isSessionUsable(session)) {
    return session.accessToken;
  }

  if (!session?.refreshToken) {
    if (session && !isSessionUsable(session)) {
      clearSession();
    }
    return null;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const currentSession = session;
      if (!currentSession?.refreshToken) return null;
      const refreshToken = currentSession.refreshToken;

      try {
        const data = await requestToken(new URLSearchParams({
          grant_type: "refresh_token",
          client_id: AUTH0_CLIENT_ID,
          refresh_token: refreshToken,
        }));
        if (session?.refreshToken !== refreshToken) {
          return session?.accessToken ?? null;
        }
        applyTokenResponse(data);
        return session?.accessToken ?? null;
      } catch (err) {
        console.error("Token refresh failed:", err);
        if (session?.refreshToken === refreshToken) {
          clearSession();
        }
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  return refreshInFlight;
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    callbackServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const code = url.searchParams.get("code");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h3>Authentication complete. You can close this tab.</h3></body></html>");

      callbackServer?.close();
      callbackServer = null;

      if (code) {
        resolve(code);
      } else {
        reject(new Error("No code in callback"));
      }
    });

    callbackServer.listen(CALLBACK_PORT, "127.0.0.1");
    callbackServer.on("error", reject);
  });
}

export async function login() {
  codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Start listening for the callback before opening the browser
  const codePromise = waitForAuthCode();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: AUTH0_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    audience: import.meta.env.VITE_AUTH0_AUDIENCE ?? "",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
  });

  const url = `https://${AUTH0_DOMAIN}/authorize?${params}`;
  await shell.openExternal(url);

  try {
    const code = await codePromise;
    await exchangeCode(code);
    await syncUser();
    return true;
  } catch (err) {
    console.error("Login failed:", err);
    codeVerifier = null;
    clearSession();
    return false;
  }
}

async function exchangeCode(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: AUTH0_CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier!,
  });

  const data = await requestToken(body);
  applyTokenResponse(data);
  codeVerifier = null;
}

async function syncUser(): Promise<void> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return;

  try {
    const res = await net.fetch(`${API_URL}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error("Failed to sync user:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Failed to sync user:", err);
  }
}

export async function logout() {
  clearSession();
  codeVerifier = null;

  // Clear Auth0 session silently without opening a browser.
  try {
    await net.fetch(`https://${AUTH0_DOMAIN}/v2/logout?client_id=${AUTH0_CLIENT_ID}`, {
      method: "GET",
      redirect: "follow",
    });
  } catch {
    // Best-effort — if it fails, next login will still prompt via PKCE
  }
}

export function notifyRenderer(win: BrowserWindow) {
  win.webContents.send("auth:state-changed", getAuthState());
}
