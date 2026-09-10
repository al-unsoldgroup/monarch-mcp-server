import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

/**
 * OAuth-protected, transparent MCP proxy.
 *
 * The Monarch SDK stays on the VPS, where its Python dependencies and durable
 * session file are supported.  This Worker owns the public OAuth resource and
 * adds the origin credential only after the OAuth provider validates the MCP
 * bearer token.  The credential is never sent to Claude or exposed to callers.
 */
const originProxy = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const origin = new URL(env.MONARCH_ORIGIN_URL);
		const target = new URL(request.url);
		origin.pathname = target.pathname;
		origin.search = target.search;

		const headers = new Headers(request.headers);
		headers.set("X-Monarch-Origin-Token", env.MONARCH_ORIGIN_TOKEN);
		headers.delete("host");

		return fetch(origin, {
			body: request.body,
			headers,
			method: request.method,
			redirect: "manual",
		});
	},
};

export default new OAuthProvider<Env, Props>({
	apiHandler: originProxy,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: { fetch: handleAccessRequest as any },
	tokenEndpoint: "/token",
	resourceMetadata: {
		authorization_servers: ["https://finance.unsold.cloud"],
		resource: "https://finance.unsold.cloud/mcp",
		scopes_supported: ["monarch:read"],
	},
	scopesSupported: ["monarch:read"],
});
