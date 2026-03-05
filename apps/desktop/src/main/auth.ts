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

let accessToken: string | null = null;
let codeVerifier: string | null = null;
let callbackServer: Server | null = null;

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
  return { isAuthenticated: accessToken !== null };
}

export function getAccessToken(): string | null {
  return accessToken;
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
    scope: "openid profile email",
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

  const response = await net.fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  accessToken = data.access_token;
  codeVerifier = null;
}

async function syncUser(): Promise<void> {
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
  accessToken = null;

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
