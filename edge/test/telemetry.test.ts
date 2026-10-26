import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	SENSITIVE_TOOLS,
	TOOL_TIERS,
	forwardWithToolCallTap,
	parseSurface,
	parseToolCall,
	responseIsError,
	sessionIdFromMcpSession,
} from "../src/telemetry.ts";

// Same table regex as tests/test_readme_tool_reference.py, which pins the
// README to the live Python registry. So README == registry == tier map.
const README = readFileSync(new URL("../../README.md", import.meta.url).pathname, "utf8");
const documented = [...README.matchAll(/^\| `(\w+)` \| .* \| .* \|$/gm)].map((m) => m[1]);

test("every documented tool has exactly one tier, and no extras", () => {
	assert.equal(documented.length, 58);
	assert.deepEqual(Object.keys(TOOL_TIERS).sort(), [...documented].sort());
});

test("tier rules", () => {
	for (const [name, tier] of Object.entries(TOOL_TIERS)) {
		if (name.startsWith("delete_")) assert.equal(tier, "destructive", name);
		if (/^(get|search)_/.test(name)) assert.equal(tier, "read", name);
		if (/^(create|set|add|bulk)_/.test(name)) assert.equal(tier, "write", name);
		if (name.startsWith("update_") && name !== "update_account") assert.equal(tier, "write", name);
		// Every read is sensitive except the static setup text; nothing else is.
		assert.equal(SENSITIVE_TOOLS.has(name), tier === "read" && name !== "setup_authentication", name);
	}
	assert.equal(TOOL_TIERS.update_account, "destructive");
	assert.equal(TOOL_TIERS.upload_account_balance_history, "destructive");
	assert.equal(TOOL_TIERS.refresh_accounts, "write");
});

test("parseSurface", () => {
	assert.equal(parseSurface("https://finance.unsold.cloud/mcp"), "claude");
	assert.equal(parseSurface("https://finance.unsold.cloud/mcp?surface=ChatGPT"), "chatgpt");
	assert.equal(parseSurface("https://finance.unsold.cloud/mcp?surface=a%20b"), "claude");
});

test("parseToolCall", () => {
	const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_accounts", arguments: {} } };
	assert.deepEqual(parseToolCall(JSON.stringify(call)), { id: 7, name: "get_accounts" });
	assert.equal(parseToolCall(JSON.stringify({ ...call, method: "tools/list" })), undefined);
	assert.equal(parseToolCall(JSON.stringify({ ...call, id: undefined })), undefined);
	assert.equal(parseToolCall("not json"), undefined);
});

test("responseIsError reads JSON and SSE bodies", () => {
	const ok = { jsonrpc: "2.0", id: 1, result: { content: [] } };
	assert.equal(responseIsError(JSON.stringify(ok), 1), false);
	assert.equal(responseIsError(JSON.stringify({ ...ok, result: { isError: true } }), 1), true);
	assert.equal(responseIsError(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), 1), true);
	const progress = { jsonrpc: "2.0", method: "notifications/progress", params: {} };
	const sse = `event: message\ndata: ${JSON.stringify(progress)}\n\n: ping\n\nevent: message\ndata: ${JSON.stringify(ok)}\n\n`;
	assert.equal(responseIsError(sse, 1), false);
	assert.equal(responseIsError(sse, 2), true, "missing response");
});

test("sessionIdFromMcpSession matches @posthog/mcp derivation", () => {
	assert.match(sessionIdFromMcpSession("abc"), /^ses_[0-9a-f]{32}$/);
	assert.equal(sessionIdFromMcpSession("abc"), sessionIdFromMcpSession("abc"));
});

async function tap(env: Record<string, string>, body: unknown, upstream: Response) {
	const captured: Array<{ url: string; body: any }> = [];
	const pending: Promise<unknown>[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		captured.push({ url, body: JSON.parse(String(init.body)) });
		return new Response("ok");
	}) as typeof fetch;
	try {
		let forwardedBody = "";
		const request = new Request("https://finance.unsold.cloud/mcp?surface=chatgpt", {
			method: "POST",
			headers: { "mcp-session-id": "sess-1", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify(body),
		});
		const response = await forwardWithToolCallTap(request, env, { waitUntil: (p) => pending.push(p) }, async (req) => {
			forwardedBody = await req.text();
			return upstream;
		});
		const clientText = await response.text();
		await Promise.all(pending);
		return { captured, clientText, forwardedBody };
	} finally {
		globalThis.fetch = realFetch;
	}
}

const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delete_transaction", arguments: { transaction_id: "secret-id" } } };

test("tap emits one $mcp_tool_call with allowlisted properties only", async () => {
	const result = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "private payload" }] } };
	const { captured, clientText, forwardedBody } = await tap(
		{ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com/", DEPLOY_GIT_SHA: "abc123" },
		call,
		new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
	);
	assert.equal(forwardedBody, JSON.stringify(call), "request body forwarded unchanged");
	assert.match(clientText, /private payload/, "client still gets the full response");
	assert.equal(captured.length, 1);
	const [{ url, body }] = captured;
	assert.equal(url, "https://eu.i.posthog.com/i/v0/e/");
	assert.equal(body.api_key, "phc_test");
	assert.equal(body.event, "$mcp_tool_call");
	assert.equal(body.distinct_id, sessionIdFromMcpSession("sess-1"));
	const { $mcp_duration_ms, ...rest } = body.properties;
	assert.equal(typeof $mcp_duration_ms, "number");
	assert.deepEqual(rest, {
		$mcp_source: "posthog_mcp_analytics",
		$session_id: sessionIdFromMcpSession("sess-1"),
		$process_person_profile: false,
		$geoip_disable: true,
		$mcp_resource_name: "delete_transaction",
		$mcp_tool_name: "delete_transaction",
		$mcp_is_error: false,
		$mcp_server_name: "monarch-mcp",
		$mcp_protocol_version: "2025-06-18",
		mcp_surface: "chatgpt",
		mcp_server_name: "monarch-mcp",
		environment: "production",
		deployment_sha: "abc123",
		tool_tier: "destructive",
		sensitive: false,
	});
	assert.doesNotMatch(JSON.stringify(body), /secret-id|private payload/);
});

test("tap marks HTTP failures as errors", async () => {
	const { captured } = await tap({ POSTHOG_PROJECT_TOKEN: "phc_test" }, call, new Response("bad gateway", { status: 502 }));
	assert.equal(captured[0].body.properties.$mcp_is_error, true);
});

test("tap is inert without a token and for non tool calls", async () => {
	const ok = new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }));
	assert.equal((await tap({}, call, ok)).captured.length, 0);
	const list = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
	assert.equal((await tap({ POSTHOG_PROJECT_TOKEN: "phc_test" }, { jsonrpc: "2.0", id: 1, method: "tools/list" }, list)).captured.length, 0);
});
