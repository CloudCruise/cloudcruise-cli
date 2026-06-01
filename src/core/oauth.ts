import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createServer } from "http";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { saveOAuthTokens, type OAuthTokens } from "./credential-store.js";

export interface OAuthSettings {
  environment: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
  baseUrl: string;
  redirectUri: string;
  scope: string;
  anonKey?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface DecodedAccessToken {
  sub?: string;
  email?: string;
  exp?: number;
  [key: string]: unknown;
}

const CLOUDCRUISE_LOGO_SVG = readFileSync(
  new URL("../../../assets/logo.svg", import.meta.url),
  "utf8",
);
const CLOUDCRUISE_LOGO_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  CLOUDCRUISE_LOGO_SVG,
)}`;

// Public Supabase anon/publishable keys for CloudCruise's known environments,
// keyed by the issuer's project origin. These are *public* by design (they ship
// in the web frontend bundle and appear in every OAuth consent flow), so
// baking them into the CLI exposes nothing — it just lets the MFA step-up work
// out of the box without a --anon-key flag. A custom/self-hosted issuer falls
// back to --anon-key or CLOUDCRUISE_OAUTH_ANON_KEY.
const DEFAULT_ANON_KEYS: Record<string, string> = {
  // Production (hrcczpkvvknatvtuwksw)
  "https://hrcczpkvvknatvtuwksw.supabase.co":
    "sb_publishable_KhdyLTPNx1GZjxjmh--VBg_kUaADMek",
  // Staging (pzxtgorsekxsydltstsb)
  "https://pzxtgorsekxsydltstsb.supabase.co":
    "sb_publishable_YkTsnwUXuylAHRfk6hZuGw_rs8Kz1zB",
}

// Resolves the built-in anon key for an issuer by its project origin, if known.
function defaultAnonKeyForIssuer(issuer: string): string | undefined {
  try {
    return DEFAULT_ANON_KEYS[new URL(issuer).origin];
  } catch {
    return undefined;
  }
}

// Built-in OAuth endpoints for CloudCruise's hosted environments. The issuer and
// clientId are *public* by design — they appear in every browser OAuth consent
// flow and in the web frontend bundle — so baking them in exposes nothing and
// lets `cloudcruise auth login` work out of the box without flags, env vars, or a
// repo-local .env. A custom/self-hosted deployment overrides any of these via
// --issuer/--client-id/--base-url or the CLOUDCRUISE_OAUTH_* env vars.
const DEFAULT_OAUTH_ENDPOINTS: Record<
  string,
  { issuer: string; clientId: string; baseUrl: string }
> = {
  production: {
    issuer: "https://hrcczpkvvknatvtuwksw.supabase.co/auth/v1",
    clientId: "9bc36be8-60c1-4138-94d7-e5d9a9659e2b",
    baseUrl: "https://api.cloudcruise.com",
  },
};

export function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generatePkce(): {
  codeVerifier: string;
  codeChallenge: string;
} {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
}

export function randomState(): string {
  return base64Url(randomBytes(32));
}

export function tokenResponseToStoredTokens(
  response: OAuthTokenResponse,
): OAuthTokens {
  const expiresAt =
    response.expires_in !== undefined
      ? Date.now() + response.expires_in * 1000
      : undefined;

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt,
    tokenType: response.token_type,
    scope: response.scope,
  };
}

export function decodeAccessToken(token: string): DecodedAccessToken {
  const [, payload] = token.split(".");
  if (!payload) return {};

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

export function resolveOAuthSettings(opts: {
  environment?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_basic";
  baseUrl?: string;
  redirectUri?: string;
  redirectPort?: string;
  scope?: string;
  anonKey?: string;
}): OAuthSettings {
  const environment =
    opts.environment ?? process.env.CLOUDCRUISE_ENV ?? "production";
  const redirectUri =
    opts.redirectUri ??
    process.env.CLOUDCRUISE_OAUTH_REDIRECT_URI ??
    `http://127.0.0.1:${opts.redirectPort ?? "9999"}/callback`;

  const defaults = DEFAULT_OAUTH_ENDPOINTS[environment];
  const issuer =
    opts.issuer ?? process.env.CLOUDCRUISE_OAUTH_ISSUER ?? defaults?.issuer;
  const clientId =
    opts.clientId ??
    process.env.CLOUDCRUISE_OAUTH_CLIENT_ID ??
    defaults?.clientId;
  const baseUrl =
    opts.baseUrl ?? process.env.CLOUDCRUISE_BASE_URL ?? defaults?.baseUrl;
  const tokenEndpointAuthMethod =
    opts.tokenEndpointAuthMethod ??
    (process.env.CLOUDCRUISE_OAUTH_TOKEN_AUTH_METHOD as
      | "none"
      | "client_secret_basic"
      | undefined) ??
    "none";

  if (!issuer || !clientId) {
    throw new Error(
      `OAuth environment "${environment}" requires --issuer and --client-id, or CLOUDCRUISE_OAUTH_ISSUER and CLOUDCRUISE_OAUTH_CLIENT_ID.`,
    );
  }
  if (!baseUrl) {
    throw new Error(
      `OAuth environment "${environment}" requires --base-url or CLOUDCRUISE_BASE_URL.`,
    );
  }
  if (
    tokenEndpointAuthMethod !== "none" &&
    tokenEndpointAuthMethod !== "client_secret_basic"
  ) {
    throw new Error(
      "CLOUDCRUISE_OAUTH_TOKEN_AUTH_METHOD must be one of: none, client_secret_basic.",
    );
  }
  if (
    tokenEndpointAuthMethod === "client_secret_basic" &&
    !(opts.clientSecret ?? process.env.CLOUDCRUISE_OAUTH_CLIENT_SECRET)
  ) {
    throw new Error(
      "OAuth token auth method client_secret_basic requires CLOUDCRUISE_OAUTH_CLIENT_SECRET.",
    );
  }

  return {
    environment,
    issuer,
    clientId,
    tokenEndpointAuthMethod,
    clientSecret:
      opts.clientSecret ?? process.env.CLOUDCRUISE_OAUTH_CLIENT_SECRET,
    baseUrl,
    redirectUri,
    scope: opts.scope ?? process.env.CLOUDCRUISE_OAUTH_SCOPE ?? "email",
    anonKey:
      opts.anonKey ??
      process.env.CLOUDCRUISE_OAUTH_ANON_KEY ??
      defaultAnonKeyForIssuer(issuer),
  };
}

export function buildAuthorizeUrl(
  settings: OAuthSettings,
  codeChallenge: string,
  state: string,
): string {
  const url = new URL(`${settings.issuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("scope", settings.scope);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const PAGE_STYLES = `<style>
    :root {
      color-scheme: light dark;
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --muted: 210 20% 90.5%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --border: 214.3 31.8% 91.4%;
      --btn-background: 210 40% 96.1%;
      --btn-background-hover: 210 40% 92%;
      --success: 142 61% 31%;
      --success-border: 142 76% 36%;
      --error: 346.8 77.2% 49.8%;
      --error-bg: 355 100% 97%;
      --shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --background: 240 5% 7%;
        --foreground: 0 0% 100%;
        --card: 240 4% 11%;
        --muted: 240 5% 15%;
        --muted-foreground: 220 13% 69%;
        --border: 223 6.9% 19.8%;
        --btn-background: 223 6.9% 19.8%;
        --btn-background-hover: 218 7.9% 27.3%;
        --success: 142 70% 45%;
        --success-border: 142 70% 45%;
        --error: 349.7 89.2% 60.2%;
        --error-bg: 349 65% 14%;
      }
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: Satoshi, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    .page {
      width: 100%;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 40px;
      background: hsl(var(--background));
    }

    .center {
      display: flex;
      width: 100%;
      justify-content: center;
    }

    main {
      width: min(100%, 350px);
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 28px 20px;
      border: 1px solid hsl(var(--border));
      border-radius: 8px;
      background: hsl(var(--card));
      box-shadow: var(--shadow);
    }

    .brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }

    .logo {
      width: 60px;
      height: 60px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      overflow: hidden;
    }

    .logo img {
      width: 60px;
      height: 60px;
      display: block;
      border-radius: 8px;
    }

    h1 {
      margin: 0;
      text-align: center;
      font-size: 24px;
      line-height: 32px;
      font-weight: 500;
      letter-spacing: 0;
    }

    .message {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px;
      border: 1px solid;
      border-radius: 8px;
      font-size: 13px;
      line-height: 18px;
      letter-spacing: 0;
      background: hsl(var(--muted));
    }

    .message.success {
      border-color: hsl(var(--success-border));
    }

    .message.error {
      border-color: hsl(var(--error));
      background: hsl(var(--error-bg));
    }

    .icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }

    .success .icon {
      color: hsl(var(--success));
    }

    .error .icon {
      color: hsl(var(--error));
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    label.lbl {
      font-size: 13px;
      color: hsl(var(--muted-foreground));
    }

    input.otp {
      width: 100%;
      padding: 12px;
      font-size: 20px;
      letter-spacing: 8px;
      text-align: center;
      border: 1px solid hsl(var(--border));
      border-radius: 8px;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
    }

    button.btn {
      width: 100%;
      padding: 10px;
      border: 1px solid hsl(var(--border));
      border-radius: 8px;
      background: hsl(var(--btn-background));
      color: hsl(var(--foreground));
      font-size: 14px;
      cursor: pointer;
    }

    button.btn:hover {
      background: hsl(var(--btn-background-hover));
    }

    button.btn:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .error-text {
      color: hsl(var(--error));
      font-size: 13px;
      min-height: 18px;
    }

    .hidden {
      display: none;
    }

    .footer {
      color: hsl(var(--muted-foreground));
      text-align: center;
      font-size: 12px;
      line-height: 16px;
    }

    .footer a {
      color: inherit;
      text-decoration: underline;
    }

    @media (max-width: 640px) {
      .page {
        padding: 24px;
      }
    }
  </style>`;

const FOOTER_HTML = `<div class="footer">
      With signing in you accept our
      <a href="https://github.com/CloudCruise/terms/blob/main/terms-of-service.md" target="_blank" rel="noopener noreferrer">terms and conditions</a>
      and confirm that you have taken note of our
      <a href="https://github.com/CloudCruise/terms/blob/main/privacy-policy.md" target="_blank" rel="noopener noreferrer">privacy policy</a>.
    </div>`;

// Wraps card content + page script in the shared CloudCruise login shell.
function pageShell(mainHtml: string, scriptHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>CloudCruise Login</title>
  ${PAGE_STYLES}
</head>
<body>
  <div class="page">
    <div></div>
    <div class="center">
      <main>
        <div class="brand">
          <div class="logo" aria-hidden="true">
            <img src="${CLOUDCRUISE_LOGO_DATA_URL}" alt="" />
          </div>
          <h1>CloudCruise</h1>
        </div>
        ${mainHtml}
      </main>
    </div>
    ${FOOTER_HTML}
  </div>
  <script>
    history.replaceState(null, "", window.location.origin + window.location.pathname);
    ${scriptHtml}
  </script>
</body>
</html>`;
}

const SUCCESS_ICON = '<path d="M20 6 9 17l-5-5"></path>';
const ERROR_ICON =
  '<circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>';

function messageBlock(tone: "success" | "error", message: string): string {
  const icon = tone === "success" ? SUCCESS_ICON : ERROR_ICON;
  return `<div class="message ${tone}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            ${icon}
          </svg>
          <span id="status-message">${message}</span>
        </div>`;
}

function callbackPage(status: "success" | "error"): string {
  const isSuccess = status === "success";
  const message = isSuccess
    ? "Login complete. Tab auto closes in 3s"
    : "Return to the terminal to see the error details and try again.";

  const script = isSuccess
    ? `
      (function () {
        var remaining = 3;
        var el = document.getElementById("status-message");
        if (!el) return;
        function tick() {
          el.textContent = "Login complete. Tab auto closes in " + remaining + "s";
          if (remaining <= 0) {
            window.close();
            return;
          }
          remaining -= 1;
          window.setTimeout(tick, 1000);
        }
        tick();
      })();
    `
    : "";

  return pageShell(messageBlock(isSuccess ? "success" : "error", message), script);
}

// The OTP-entry page served on the CLI's local callback server when the
// just-issued (aal1) session needs an MFA step-up. The user types the code
// here; it POSTs to /mfa-verify on the same local server, which holds the
// access token and performs the challenge/verify.
function mfaPage(friendlyName: string | undefined, nonce: string): string {
  const labelSuffix = friendlyName
    ? ` (${friendlyName.replace(/[<>&"]/g, "")})`
    : "";
  const main = `
        <div class="message">
          <span>Enter the 6-digit code from your authenticator app to finish signing in.</span>
        </div>
        <form id="mfa-form" class="field">
          <label class="lbl" for="code">Authentication code${labelSuffix}</label>
          <input id="code" class="otp" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-label="Authentication code" />
          <div id="err" class="error-text"></div>
          <button id="submit" class="btn" type="submit">Verify</button>
        </form>
        ${messageBlock("success", "Login complete. Tab auto closes in 3s").replace(
          'class="message success"',
          'class="message success hidden" id="success-block"',
        )}`;

  const script = `
      (function () {
        var form = document.getElementById("mfa-form");
        var input = document.getElementById("code");
        var err = document.getElementById("err");
        var btn = document.getElementById("submit");
        var successBlock = document.getElementById("success-block");
        var statusMessage = document.getElementById("status-message");
        function setErr(m) { err.textContent = m || ""; }
        function showSuccess() {
          form.classList.add("hidden");
          successBlock.classList.remove("hidden");
          var remaining = 3;
          function tick() {
            statusMessage.textContent = "Login complete. Tab auto closes in " + remaining + "s";
            if (remaining <= 0) { window.close(); return; }
            remaining -= 1;
            window.setTimeout(tick, 1000);
          }
          tick();
        }
        async function submit(e) {
          if (e) e.preventDefault();
          var code = (input.value || "").trim();
          if (!/^[0-9]{6}$/.test(code)) { setErr("Enter 6 digits."); return; }
          btn.disabled = true; setErr("");
          try {
            var res = await fetch("/mfa-verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: code, nonce: ${JSON.stringify(nonce)} }),
            });
            if (res.ok) { showSuccess(); return; }
            var body = await res.json().catch(function () { return {}; });
            setErr(body.error || "Invalid code, try again.");
            input.value = ""; input.focus();
          } catch (_) {
            setErr("Network error, try again.");
          }
          btn.disabled = false;
        }
        form.addEventListener("submit", submit);
        input.addEventListener("input", function () {
          if (input.value.length === 6) submit();
        });
        input.focus();
      })();
    `;

  return pageShell(main, script);
}

function htmlHeaders(allowConnectSelf = false): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" +
      (allowConnectSelf ? " connect-src 'self';" : "") +
      " base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

// Runs the full browser login on the local callback server and returns the
// final token response. The server stays alive across the OAuth callback AND
// (when the issued aal1 session belongs to an MFA-enrolled user) an MFA
// step-up: it serves an OTP page, accepts the code via POST /mfa-verify, and
// performs the challenge/verify against GoTrue using the token it just minted.
// Yields a genuine aal2 token for MFA users; an unchanged aal1 token otherwise.
export async function runBrowserAuthFlow(
  settings: OAuthSettings,
  codeVerifier: string,
  expectedState: string,
  options: { explicitMfaCode?: string } = {},
): Promise<OAuthTokenResponse> {
  const callback = new URL(settings.redirectUri);

  return new Promise((resolve, reject) => {
    let pending: { factorId: string; accessToken: string; nonce: string } | null =
      null;
    let settled = false;

    const finish = (
      result: { ok: true; value: OAuthTokenResponse } | { ok: false; err: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      server.close();
      if (result.ok) resolve(result.value);
      else reject(result.err);
    };

    const sendJson = (
      res: import("http").ServerResponse,
      status: number,
      body: unknown,
    ): void => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };

    const server = createServer((req, res) => {
      void (async () => {
        try {
          const requestUrl = new URL(req.url ?? "/", settings.redirectUri);

          // OTP code submitted from the hosted MFA page.
          if (req.method === "POST" && requestUrl.pathname === "/mfa-verify") {
            if (!pending) {
              sendJson(res, 409, { error: "No pending MFA challenge." });
              return;
            }
            let raw = "";
            for await (const chunk of req) raw += chunk;
            let code = "";
            let nonce = "";
            try {
              const body = JSON.parse(raw) as { code?: unknown; nonce?: unknown };
              code = String(body.code ?? "").trim();
              nonce = String(body.nonce ?? "");
            } catch {
              /* fall through to validation below */
            }
            // Flow-bound nonce: the OTP page embeds a per-flow secret that a
            // cross-site or unrelated local caller can't read (cross-origin
            // reads of the callback page are blocked), so it can't blindly POST
            // codes to the loopback server. Timing-safe compare.
            const nonceBytes = Buffer.from(nonce);
            const expectedNonceBytes = Buffer.from(pending.nonce);
            if (
              nonceBytes.length !== expectedNonceBytes.length ||
              !timingSafeEqual(nonceBytes, expectedNonceBytes)
            ) {
              sendJson(res, 403, { error: "Invalid request." });
              return;
            }
            if (!/^\d{6}$/.test(code)) {
              sendJson(res, 422, { error: "Enter a 6-digit code." });
              return;
            }
            try {
              const challengeId = await challengeMfaFactor(
                settings,
                pending.accessToken,
                pending.factorId,
              );
              const elevated = await verifyMfaChallenge(
                settings,
                pending.accessToken,
                pending.factorId,
                challengeId,
                code,
              );
              sendJson(res, 200, { ok: true });
              finish({ ok: true, value: elevated });
            } catch (err: unknown) {
              // Wrong/expired code — let the user retry; keep the server open.
              sendJson(res, 422, {
                error:
                  err instanceof Error ? err.message : "Verification failed.",
              });
            }
            return;
          }

          // OAuth redirect callback.
          if (requestUrl.pathname !== callback.pathname) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const code = requestUrl.searchParams.get("code");
          const state = requestUrl.searchParams.get("state");
          const error = requestUrl.searchParams.get("error");
          const errorDescription =
            requestUrl.searchParams.get("error_description");

          if (error) throw new Error(errorDescription ?? error);
          if (!code || !state) {
            throw new Error("OAuth callback was missing code or state.");
          }
          const stateBytes = Buffer.from(state);
          const expectedStateBytes = Buffer.from(expectedState);
          if (
            stateBytes.length !== expectedStateBytes.length ||
            !timingSafeEqual(stateBytes, expectedStateBytes)
          ) {
            throw new Error("OAuth callback state did not match.");
          }

          const tokenResponse = await exchangeAuthorizationCode(
            settings,
            code,
            codeVerifier,
          );
          const claims = decodeAccessToken(tokenResponse.access_token);

          // Step up to aal2 if the user has a verified TOTP factor. Requires
          // the anon key for GoTrue's /factors endpoints; without it (unknown
          // issuer, no override) we fall through to the aal1 token.
          if (claims.aal !== "aal2" && settings.anonKey) {
            // Fail closed: if we can't determine MFA status we must not silently
            // persist an aal1 token — an MFA-enrolled user would get a session
            // that's rejected by every RLS-gated call with no visible cause.
            // Abort the login so the user can retry instead.
            let factors: MfaFactor[];
            try {
              factors = await fetchMfaFactors(settings, tokenResponse.access_token);
            } catch (err: unknown) {
              throw new Error(
                `Could not verify MFA status (${
                  err instanceof Error ? err.message : String(err)
                }). Login aborted to avoid saving a limited session — please try again.`,
              );
            }
            const totp = factors.find(
              (f) => f.factor_type === "totp" && f.status === "verified",
            );
            if (totp) {
              if (options.explicitMfaCode) {
                if (!/^\d{6}$/.test(options.explicitMfaCode)) {
                  throw new Error("--mfa-code must be a 6-digit TOTP code.");
                }
                const challengeId = await challengeMfaFactor(
                  settings,
                  tokenResponse.access_token,
                  totp.id,
                );
                const elevated = await verifyMfaChallenge(
                  settings,
                  tokenResponse.access_token,
                  totp.id,
                  challengeId,
                  options.explicitMfaCode,
                );
                res.writeHead(200, htmlHeaders());
                res.end(callbackPage("success"));
                finish({ ok: true, value: elevated });
                return;
              }
              // Interactive: serve the OTP page and keep the server open for
              // the POST /mfa-verify that follows. The nonce binds that POST to
              // this page so a cross-site/unrelated caller can't submit codes.
              const nonce = base64Url(randomBytes(32));
              pending = {
                factorId: totp.id,
                accessToken: tokenResponse.access_token,
                nonce,
              };
              res.writeHead(200, htmlHeaders(true));
              res.end(mfaPage(totp.friendly_name, nonce));
              return;
            }
          }

          // No MFA step-up needed.
          res.writeHead(200, htmlHeaders());
          res.end(callbackPage("success"));
          finish({ ok: true, value: tokenResponse });
        } catch (err: unknown) {
          if (!res.headersSent) {
            res.writeHead(400, htmlHeaders());
            res.end(callbackPage("error"));
          }
          finish({ ok: false, err });
        }
      })();
    });

    server.on("error", (err) => finish({ ok: false, err }));
    server.listen(Number(callback.port), callback.hostname);
  });
}

export async function exchangeAuthorizationCode(
  settings: OAuthSettings,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    code_verifier: codeVerifier,
  });
  return tokenRequest(settings, body);
}

export interface MfaFactor {
  id: string;
  status: string;
  factor_type: string;
  friendly_name?: string;
}

// GoTrue's REST endpoints (unlike the /oauth/* family) require an `apikey`
// header carrying the project's public anon key. supabase-js attaches it
// transparently in the browser; the CLI must supply it here. Without
// settings.anonKey these calls 401 with "No API key found in request".
function gotrueHeaders(
  settings: { anonKey?: string },
  accessToken: string,
): Record<string, string> {
  if (!settings.anonKey) {
    throw new Error(
      "MFA step-up requires the Supabase anon key. Pass --anon-key or set CLOUDCRUISE_OAUTH_ANON_KEY.",
    );
  }
  return {
    apikey: settings.anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// Returns the user's enrolled MFA factors (empty if none). Used to decide
// whether a step-up TOTP challenge is needed after an aal1 OAuth login.
export async function fetchMfaFactors(
  settings: { issuer: string; anonKey?: string },
  accessToken: string,
): Promise<MfaFactor[]> {
  const res = await fetch(`${settings.issuer}/user`, {
    headers: gotrueHeaders(settings, accessToken),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fetching MFA factors failed (${res.status}): ${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("MFA factor lookup returned invalid JSON.");
  }
  const factors = (parsed as { factors?: unknown }).factors;
  return Array.isArray(factors) ? (factors as MfaFactor[]) : [];
}

// Begins an MFA challenge for a factor; returns the challenge id needed by
// verifyMfaChallenge. Calls the same GoTrue endpoint as supabase-js
// mfa.challenge().
export async function challengeMfaFactor(
  settings: { issuer: string; anonKey?: string },
  accessToken: string,
  factorId: string,
): Promise<string> {
  const res = await fetch(
    `${settings.issuer}/factors/${encodeURIComponent(factorId)}/challenge`,
    {
      method: "POST",
      headers: gotrueHeaders(settings, accessToken),
      body: "{}",
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MFA challenge failed (${res.status}): ${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("MFA challenge returned invalid JSON.");
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || !id) {
    throw new Error("MFA challenge response was missing a challenge id.");
  }
  return id;
}

// Verifies a TOTP code against a challenge. On success GoTrue upgrades the
// caller's session to aal2 and returns a fresh access/refresh token pair for
// that same session — same endpoint as supabase-js mfa.verify().
export async function verifyMfaChallenge(
  settings: { issuer: string; anonKey?: string },
  accessToken: string,
  factorId: string,
  challengeId: string,
  code: string,
): Promise<OAuthTokenResponse> {
  const res = await fetch(
    `${settings.issuer}/factors/${encodeURIComponent(factorId)}/verify`,
    {
      method: "POST",
      headers: gotrueHeaders(settings, accessToken),
      body: JSON.stringify({ challenge_id: challengeId, code }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MFA verification failed (${res.status}): ${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("MFA verification returned invalid JSON.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as OAuthTokenResponse).access_token !== "string" ||
    !(parsed as OAuthTokenResponse).access_token
  ) {
    throw new Error("MFA verification response was missing access_token.");
  }
  return parsed as OAuthTokenResponse;
}

export async function refreshOAuthToken(
  settings: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: "none" | "client_secret_basic";
  },
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenRequest(settings, body);
}

async function tokenRequest(
  settings: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: "none" | "client_secret_basic";
  },
  body: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (settings.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!settings.clientSecret) {
      throw new Error("OAuth client_secret_basic refresh requires a client secret.");
    }
    headers.Authorization = `Basic ${Buffer.from(
      `${settings.clientId}:${settings.clientSecret}`,
    ).toString("base64")}`;
  } else {
    body.set("client_id", settings.clientId);
  }

  const res = await fetch(`${settings.issuer}/oauth/token`, {
    method: "POST",
    headers,
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth token request failed (${res.status}): ${text}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OAuth token request returned invalid JSON.");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as OAuthTokenResponse).access_token !== "string" ||
    !(parsed as OAuthTokenResponse).access_token
  ) {
    throw new Error("OAuth token response was missing access_token.");
  }

  const response = parsed as OAuthTokenResponse;
  if (
    response.expires_in !== undefined &&
    typeof response.expires_in !== "number"
  ) {
    throw new Error("OAuth token response had an invalid expires_in value.");
  }

  return response;
}

export function saveTokenResponse(
  account: string,
  response: OAuthTokenResponse,
): OAuthTokens {
  const tokens = tokenResponseToStoredTokens(response);
  saveOAuthTokens(account, tokens);
  return tokens;
}
