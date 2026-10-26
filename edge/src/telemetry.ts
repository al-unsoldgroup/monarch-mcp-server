/**
 * PostHog MCP analytics for tools/call requests passing through the edge.
 *
 * The shared @unsoldgroup/mcp-telemetry package instruments an McpServer
 * instance. This Worker does not host one: it is a transparent OAuth proxy in
 * front of the Python FastMCP origin. So it taps the JSON-RPC traffic instead
 * and emits the event @posthog/mcp would emit after the shared package's
 * allowlist: same event name, same property names, no arguments or results.
 */

export type ToolTier = "read" | "write" | "destructive";

const READ_TOOLS = [
	"check_auth_status",
	"debug_session_loading",
	"get_account_balance_history",
	"get_account_holdings",
	"get_account_sync_health",
	"get_accounts",
	"get_budgets",
	"get_cashflow",
	"get_cashflow_by_month",
	"get_category_details",
	"get_debt_paydown",
	"get_goal_contributions",
	"get_goals",
	"get_merchant",
	"get_net_worth",
	"get_net_worth_by_account_type",
	"get_recurring_transactions",
	"get_spending_summary",
	"get_transaction_categories",
	"get_transaction_category_groups",
	"get_transaction_details",
	"get_transaction_rules",
	"get_transaction_splits",
	"get_transaction_tags",
	"get_transactions",
	"get_transactions_needing_review",
	"get_transactions_summary",
	"monarch_whoami",
	"search_transactions",
	"setup_authentication",
] as const;

const WRITE_TOOLS = [
	"add_transaction_tag",
	"bulk_categorize_transactions",
	"categorize_transaction",
	"create_transaction",
	"create_transaction_category",
	"create_transaction_rule",
	"create_transaction_tag",
	"mark_transaction_reviewed",
	"monarch_login",
	"monarch_login_with_token",
	"refresh_accounts",
	"reorder_transaction_rule",
	"review_recurring_stream",
	"set_budget_amount",
	"set_goal_contribution",
	"set_transaction_tags",
	"split_transaction",
	"update_category",
	"update_merchant",
	"update_savings_goal",
	"update_transaction",
	"update_transaction_notes",
	"update_transaction_rule",
] as const;

// Deletes, balance overwrites, and dropping the stored Monarch session.
const DESTRUCTIVE_TOOLS = [
	"delete_transaction",
	"delete_transaction_rule",
	"monarch_logout",
	"update_account",
	"upload_account_balance_history",
] as const;

export const TOOL_TIERS: Readonly<Record<string, ToolTier>> = Object.freeze({
	...Object.fromEntries(READ_TOOLS.map((name) => [name, "read" as const])),
	...Object.fromEntries(WRITE_TOOLS.map((name) => [name, "write" as const])),
	...Object.fromEntries(DESTRUCTIVE_TOOLS.map((name) => [name, "destructive" as const])),
});

// Every read returns Monarch financial data, except the static setup text.
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set(
	READ_TOOLS.filter((name) => name !== "setup_authentication"),
);

const SURFACE = /^[a-z0-9_-]{1,32}$/;

/** Same contract as the shared package: missing or malformed ?surface= is "claude". */
export function parseSurface(url: string | URL): string {
	try {
		const surface = new URL(url).searchParams.get("surface")?.toLowerCase() ?? "";
		return SURFACE.test(surface) ? surface : "claude";
	} catch {
		return "claude";
	}
}

/** @posthog/mcp derives $session_id from Mcp-Session-Id this way; kept identical so sessions line up. */
export function sessionIdFromMcpSession(mcpSessionId: string): string {
	return `ses_${fnv1aHex(mcpSessionId)}${fnv1aHex(`${mcpSessionId}::salt`)}`;
}

function fnv1aHex(input: string): string {
	let h1 = 0x84222325;
	let h2 = 0xcbf29ce4;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x000001b3);
		h2 = Math.imul(h2 ^ c, 0x00000193);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

type JsonRpcId = string | number;

/** Returns the id and tool name when the body is a single tools/call request. */
export function parseToolCall(body: string): { id: JsonRpcId; name: string } | undefined {
	// ponytail: single messages only. JSON-RPC batches were dropped from the
	// 2025-06-18 transport; a batched call passes through untracked.
	try {
		const message = JSON.parse(body);
		const name = message?.params?.name;
		const id = message?.id;
		if (message?.method !== "tools/call" || typeof name !== "string") return undefined;
		if (typeof id !== "string" && typeof id !== "number") return undefined;
		return { id, name };
	} catch {
		return undefined;
	}
}

/**
 * Finds the JSON-RPC response for `id` in a JSON or SSE body. A JSON-RPC error
 * or a tool result with isError counts as an error; an unparseable or missing
 * response counts as an error too, since the caller got no usable result.
 */
export function responseIsError(body: string, id: JsonRpcId): boolean {
	const candidates = body.trimStart().startsWith("{") || body.trimStart().startsWith("[")
		? [body]
		: body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
				if (message?.id !== id) continue;
				return message.error !== undefined || message.result?.isError === true;
			}
		} catch {
			// Not JSON: an SSE comment or keep-alive line.
		}
	}
	return true;
}

export interface TelemetryEnv {
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	ENVIRONMENT?: string;
	DEPLOY_GIT_SHA?: string;
}

export const SERVER_NAME = "monarch-mcp";

export function toolCallEvent(input: {
	tool: string;
	durationMs: number;
	isError: boolean;
	surface: string;
	mcpSessionId: string | null;
	protocolVersion: string | null;
	env: TelemetryEnv;
}) {
	const sessionId = input.mcpSessionId ? sessionIdFromMcpSession(input.mcpSessionId) : undefined;
	const tier = TOOL_TIERS[input.tool];
	return {
		event: "$mcp_tool_call",
		distinct_id: sessionId ?? "anonymous",
		timestamp: new Date().toISOString(),
		properties: {
			$mcp_source: "posthog_mcp_analytics",
			...(sessionId ? { $session_id: sessionId } : {}),
			$process_person_profile: false,
			$geoip_disable: true,
			$mcp_resource_name: input.tool,
			$mcp_tool_name: input.tool,
			$mcp_duration_ms: input.durationMs,
			$mcp_is_error: input.isError,
			$mcp_server_name: SERVER_NAME,
			...(input.protocolVersion ? { $mcp_protocol_version: input.protocolVersion } : {}),
			mcp_surface: input.surface,
			mcp_server_name: SERVER_NAME,
			environment: input.env.ENVIRONMENT ?? "production",
			deployment_sha: input.env.DEPLOY_GIT_SHA ?? "unknown",
			...(tier ? { tool_tier: tier } : {}),
			sensitive: SENSITIVE_TOOLS.has(input.tool),
		},
	};
}

interface WaitUntil {
	waitUntil(promise: Promise<unknown>): void;
}

/**
 * Forwards the request and, for a tools/call with a PostHog token set, records
 * one $mcp_tool_call event after the response body finishes. The response is
 * streamed to the client untouched; the tap reads a tee'd copy off the hot path.
 */
export async function forwardWithToolCallTap(
	request: Request,
	env: TelemetryEnv,
	ctx: WaitUntil,
	forward: (request: Request) => Promise<Response>,
): Promise<Response> {
	if (!env.POSTHOG_PROJECT_TOKEN || request.method !== "POST") return forward(request);

	const body = await request.text();
	const call = parseToolCall(body);
	const started = Date.now();
	const response = await forward(new Request(request, { body }));
	if (!call) return response;

	const [toClient, toTap] = response.body ? response.body.tee() : [null, null];
	const surface = parseSurface(request.url);
	const mcpSessionId = request.headers.get("mcp-session-id") ?? response.headers.get("mcp-session-id");
	const protocolVersion = request.headers.get("mcp-protocol-version");
	ctx.waitUntil(
		(async () => {
			const text = toTap ? await new Response(toTap).text() : "";
			const event = toolCallEvent({
				tool: call.name,
				durationMs: Date.now() - started,
				isError: !response.ok || responseIsError(text, call.id),
				surface,
				mcpSessionId,
				protocolVersion,
				env,
			});
			const host = (env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
			await fetch(`${host}/i/v0/e/`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ api_key: env.POSTHOG_PROJECT_TOKEN, ...event }),
			});
		})().catch(() => console.error("[posthog-mcp] event delivery failed")),
	);
	return new Response(toClient, response);
}
