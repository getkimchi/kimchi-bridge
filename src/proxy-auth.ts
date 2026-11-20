import type { SignIn } from "./kimchi.ts";
import { CODEX_SUBSCRIPTION_ROUTE, type CodexRoute } from "./codex.ts";
import {
  bearerToken,
  ensureFresh,
  gatewayHeaders,
  ORGANIZATION_HEADER,
  type OAuthCredential,
} from "./oauth.ts";

const PROXY_PLACEHOLDER = "kimchi-gateway";
const RESPONSES_PATH = "/openai/v1/responses";

export type ProxyAuthPlan =
  | { kind: "unauthenticated" }
  | { kind: "missing-subscription-credentials" }
  | { kind: "authenticated"; subscription: boolean; headers(): Promise<Record<string, string>> };

export interface ProxyAuthInput {
  request: Request;
  pathname: string;
  model: unknown;
  routeFor(model: unknown): CodexRoute;
  credential?: OAuthCredential;
  signIn?: SignIn;
}

/**
 * Decides which credential a proxied request carries. A subscription call keeps the incoming ChatGPT login and adds a
 * Kimchi credential beside it, because the login owns `Authorization`; every other call drops that login and uses the
 * saved Kimchi sign-in alone.
 */
export function planProxyAuth(input: ProxyAuthInput): ProxyAuthPlan {
  const { credential, signIn } = input;
  if (!credential && !signIn?.token) return { kind: "unauthenticated" };
  const subscription =
    input.pathname === RESPONSES_PATH && input.routeFor(input.model) === CODEX_SUBSCRIPTION_ROUTE;
  if (!subscription)
    return {
      kind: "authenticated",
      subscription: false,
      headers: async () => (credential ? gatewayHeaders(await ensureFresh()) : keyHeaders(signIn!)),
    };
  const chatGPT = chatGPTAuthorization(input.request);
  const key = credential ? undefined : subscriptionKey(signIn);
  const usable = key || (credential?.orgId ? bearerToken(credential) : "");
  if (!chatGPT || !usable) return { kind: "missing-subscription-credentials" };
  return {
    kind: "authenticated",
    subscription: true,
    headers: async () => {
      const authorization = chatGPT;
      if (!credential) return { Authorization: authorization, "X-API-Key": key! };
      const fresh = await ensureFresh();
      const refreshed: Record<string, string> = {
        Authorization: authorization,
        "X-API-Key": bearerToken(fresh),
      };
      if (fresh.orgId) refreshed[ORGANIZATION_HEADER] = fresh.orgId;
      return refreshed;
    },
  };
}

/** A Kimchi API key may serve subscription calls only when it carries no SSO organization of its own. */
function subscriptionKey(signIn: SignIn | undefined): string | undefined {
  return signIn?.token && !signIn.organizationId ? signIn.token : undefined;
}

/** The gateway auth for Kimchi's API-key sign-in: its bearer, and its SSO organization when it has one. */
export function keyHeaders(signIn: SignIn): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${signIn.token}` };
  if (signIn.organizationId) headers[ORGANIZATION_HEADER] = signIn.organizationId;
  return headers;
}

/** Codex sends its own placeholder when no ChatGPT login exists, and that must never look like a subscription login. */
function chatGPTAuthorization(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length);
  if (
    !token ||
    token === PROXY_PLACEHOLDER ||
    [...token].some((character) => character.trim().length === 0)
  )
    return undefined;
  return authorization;
}
