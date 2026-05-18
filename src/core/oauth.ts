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
  baseUrl: string;
  redirectUri: string;
  scope: string;
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
  baseUrl?: string;
  redirectUri?: string;
  redirectPort?: string;
  scope?: string;
}): OAuthSettings {
  const environment =
    opts.environment ?? process.env.CLOUDCRUISE_ENV ?? "production";
  const redirectUri =
    opts.redirectUri ??
    process.env.CLOUDCRUISE_OAUTH_REDIRECT_URI ??
    `http://127.0.0.1:${opts.redirectPort ?? "9999"}/callback`;

  const issuer = opts.issuer ?? process.env.CLOUDCRUISE_OAUTH_ISSUER;
  const clientId = opts.clientId ?? process.env.CLOUDCRUISE_OAUTH_CLIENT_ID;
  const baseUrl =
    opts.baseUrl ??
    process.env.CLOUDCRUISE_BASE_URL ??
    (environment === "production" ? "https://api.cloudcruise.com" : undefined);

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

  return {
    environment,
    issuer,
    clientId,
    clientSecret:
      opts.clientSecret ?? process.env.CLOUDCRUISE_OAUTH_CLIENT_SECRET,
    baseUrl,
    redirectUri,
    scope: opts.scope ?? process.env.CLOUDCRUISE_OAUTH_SCOPE ?? "email",
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

function callbackPage(status: "success" | "error"): string {
  const isSuccess = status === "success";
  const message = isSuccess
    ? "Login complete. Tab auto closes in 3s"
    : "Return to the terminal to see the error details and try again.";
  const toneClass = isSuccess ? "success" : "error";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>CloudCruise Login</title>
  <style>
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
  </style>
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
        <div class="message ${toneClass}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            ${isSuccess ? '<path d="M20 6 9 17l-5-5"></path>' : '<circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>'}
          </svg>
          <span id="status-message">${message}</span>
        </div>
      </main>
    </div>
    <div class="footer">
      With signing in you accept our
      <a href="https://github.com/CloudCruise/terms/blob/main/terms-of-service.md" target="_blank" rel="noopener noreferrer">terms and conditions</a>
      and confirm that you have taken note of our
      <a href="https://github.com/CloudCruise/terms/blob/main/privacy-policy.md" target="_blank" rel="noopener noreferrer">privacy policy</a>.
    </div>
  </div>
  <script>
    history.replaceState(null, "", window.location.origin + window.location.pathname);
    ${
      isSuccess
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
        : ""
    }
  </script>
</body>
</html>`;
}

export async function waitForAuthorizationCode(
  redirectUri: string,
  expectedState: string,
): Promise<string> {
  const callback = new URL(redirectUri);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirectUri);
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

        if (error) {
          throw new Error(errorDescription ?? error);
        }
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

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        res.end(callbackPage("success"));
        server.close();
        resolve(code);
      } catch (err: unknown) {
        res.writeHead(400, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        res.end(callbackPage("error"));
        server.close();
        reject(err);
      }
    });

    server.on("error", reject);
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

export async function refreshOAuthToken(
  settings: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
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
  },
  body: URLSearchParams,
): Promise<OAuthTokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (settings.clientSecret) {
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
  return JSON.parse(text) as OAuthTokenResponse;
}

export function saveTokenResponse(
  account: string,
  response: OAuthTokenResponse,
): OAuthTokens {
  const tokens = tokenResponseToStoredTokens(response);
  saveOAuthTokens(account, tokens);
  return tokens;
}
