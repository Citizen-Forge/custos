import { createHash, randomBytes } from "node:crypto";

// Reverse-engineered from Claude Code's own login flow (client_id and endpoints
// are shared publicly across several open-source re-implementations, e.g.
// github.com/querymt/anthropic-auth). Anthropic can change these at any time.
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
export const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// This is the redirect_uri Claude Code registers with the auth request; the
// authorize page then shows a "code#state" string for the user to copy back
// into the CLI rather than actually redirecting a browser to a local server.
export const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

export type OAuthMode = "max" | "console";

export interface OAuthFlow {
  authorizationUrl: string;
  verifier: string;
  state: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function startOAuthFlow(mode: OAuthMode): OAuthFlow {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const baseDomain = mode === "max" ? "claude.ai" : "console.anthropic.com";
  const url = new URL(`https://${baseDomain}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return { authorizationUrl: url.toString(), verifier, state };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

async function postToken(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed: HTTP ${res.status} - ${text}`);
  }

  const json = (await res.json()) as TokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** Exchange the "code#state" string the user pastes back from the browser. */
export async function exchangeCode(
  codeWithState: string,
  flow: OAuthFlow,
): Promise<TokenSet> {
  const hashPos = codeWithState.indexOf("#");
  const code = hashPos >= 0 ? codeWithState.slice(0, hashPos) : codeWithState;
  const returnedState = hashPos >= 0 ? codeWithState.slice(hashPos + 1) : flow.state;

  if (returnedState !== flow.state) {
    throw new Error("OAuth state mismatch - possible CSRF, restart the login flow");
  }

  return postToken({
    code,
    state: returnedState,
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: flow.verifier,
  });
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
}
