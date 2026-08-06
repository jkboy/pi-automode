import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_CLASSIFIER_RETRY,
	buildEffectiveConfigFromSources,
	classifierRetryDelayMs,
	classifyInStages,
	classifyWithRetry,
	isNonRetryableClassifierError,
	validateSettingsFile,
	waitForClassifierRetry,
} from "../extensions/auto-mode.ts";
import type { ClassifierIoAttempt } from "../extensions/auto-mode.ts";

const VALID_ALLOW = '{"decision":"allow","tier":"allow","reason":"read-only"}';

function assistantWith(text: string, stopReason = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
		...(errorMessage === undefined ? {} : { errorMessage }),
	} satisfies AssistantMessage;
}

/** fakeComplete that also accepts Error entries, which are thrown. */
function fakeCompleteOrThrow(responses: Array<AssistantMessage | Error>) {
	let calls = 0;
	const fn = async () => {
		const item = responses[Math.min(calls, responses.length - 1)];
		calls += 1;
		if (item instanceof Error) throw item;
		return item;
	};
	return { fn: fn as never, callCount: () => calls };
}

const STAGE_PROMPT = {
	systemPrompt: "policy",
	contextMessage: {
		role: "user" as const,
		content: [{ type: "text" as const, text: "context" }],
		timestamp: 1,
	},
};

test("fast stage retries transient thrown errors with doubling backoff and recovers", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		new Error("500 Internal Server Error"),
		new Error("Request timed out."),
		assistantWith("0"),
	]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{
			sessionId: "s",
			retry: { maxAttempts: 3, baseDelayMs: 5 },
			onAttempt: (a) => attempts.push(a),
		},
	);

	assert.equal(decision.decision, "allow");
	assert.equal(callCount(), 3);
	assert.equal(attempts.length, 3);
	assert.match(attempts[0]?.error ?? "", /500/);
	assert.equal(attempts[0]?.retryDelayMs, 5);
	assert.match(attempts[1]?.error ?? "", /timed out/);
	assert.equal(attempts[1]?.retryDelayMs, 10);
	assert.equal(attempts[2]?.retryDelayMs, undefined);
	assert.equal(attempts[2]?.response?.text, "0");
});

test("fast stage retries provider-reported error responses (stopReason error)", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("", "error", "upstream HTTP/2 stream failed"),
		assistantWith("0"),
	]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{
			sessionId: "s",
			retry: { maxAttempts: 3, baseDelayMs: 0 },
			onAttempt: (a) => attempts.push(a),
		},
	);

	assert.equal(decision.decision, "allow");
	assert.equal(callCount(), 2);
	assert.equal(attempts[0]?.response?.errorMessage, "upstream HTTP/2 stream failed");
	assert.equal(attempts[0]?.retryDelayMs, 0);
});

test("fast stage fails closed immediately on a non-retryable auth error", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([new Error("401 Unauthorized")]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{
			sessionId: "s",
			retry: { maxAttempts: 3, baseDelayMs: 0 },
			onAttempt: (a) => attempts.push(a),
		},
	);

	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /401/);
	assert.equal(callCount(), 1);
	assert.equal(attempts[0]?.retryDelayMs, undefined);
});

test("fast stage fails closed after exhausting the transient retry budget", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([new Error("socket hang up")]);
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{ sessionId: "s", retry: { maxAttempts: 3, baseDelayMs: 0 } },
	);

	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /fails closed.*socket hang up/);
	assert.equal(callCount(), 3);
});

const OPENROUTER_SHARED_POOL_429 =
	'429 {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.7-flash is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits.","provider_error_code":"insufficient_quota","limit_source":"upstream_provider_shared_pool"}}}';

test("fast stage retries a shared-pool 429 wrapped as insufficient_quota and recovers", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("", "error", OPENROUTER_SHARED_POOL_429),
		assistantWith("0"),
	]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{
			sessionId: "s",
			retry: { maxAttempts: 3, baseDelayMs: 0 },
			onAttempt: (a) => attempts.push(a),
		},
	);

	assert.equal(decision.decision, "allow");
	assert.equal(callCount(), 2);
	assert.equal(attempts[0]?.retryDelayMs, 0);
});

test("fast stage retries a length-truncated response immediately and recovers", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("", "length"),
		assistantWith("0"),
	]);
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{ sessionId: "s", retry: { maxAttempts: 3, baseDelayMs: 0 } },
	);

	assert.equal(decision.decision, "allow");
	assert.equal(callCount(), 2);
});

test("fast stage never trusts a digit from a truncated response", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("0", "length"),
	]);
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{ sessionId: "s", retry: { maxAttempts: 3, baseDelayMs: 0 } },
	);

	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /truncated before producing a 0\/1 verdict/);
	assert.equal(callCount(), 2);
});

test("fast stage fails closed with a truncation reason after repeated length stops", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([assistantWith("", "length")]);
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{ sessionId: "s", retry: { maxAttempts: 3, baseDelayMs: 0 } },
	);

	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /truncated before producing a 0\/1 verdict/);
	assert.equal(callCount(), 2);
});

test("fast stage retries a non-0/1 response once and recovers", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("maybe"),
		assistantWith("0"),
	]);
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{ sessionId: "s", retry: { maxAttempts: 3, baseDelayMs: 0 } },
	);

	assert.equal(decision.decision, "allow");
	assert.equal(callCount(), 2);
});

test("detailed stage retries a transient error with backoff and recovers", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("1"),
		new Error("503 Service Unavailable"),
		assistantWith(VALID_ALLOW),
	]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{
			sessionId: "s",
			retry: { maxAttempts: 3, baseDelayMs: 0 },
			onAttempt: (a) => attempts.push(a),
		},
	);

	assert.equal(decision.decision, "allow");
	assert.equal(callCount(), 3);
	assert.deepEqual(
		attempts.map((a) => a.stage),
		["fast", "detailed", "detailed"],
	);
});

test("detailed stage fails closed immediately on insufficient_quota", async () => {
	const { fn, callCount } = fakeCompleteOrThrow([
		assistantWith("1"),
		assistantWith("", "error", "insufficient_quota: your account has run out"),
	]);
	const decision = await classifyInStages(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		STAGE_PROMPT,
		undefined,
		{ sessionId: "s", retry: { maxAttempts: 3, baseDelayMs: 0 } },
	);

	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /insufficient_quota/);
	assert.equal(callCount(), 2);
});

test("aborting the signal during backoff fails closed promptly", async () => {
	const controller = new AbortController();
	const { fn, callCount } = fakeCompleteOrThrow([new Error("500 upstream blew up")]);
	setTimeout(() => controller.abort(), 5);
	const started = Date.now();
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } } as never,
		{ systemPrompt: "s", messages: [] },
		controller.signal,
		{ retry: { maxAttempts: 3, baseDelayMs: 1000 } },
	);

	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /abort/i);
	assert.ok(Date.now() - started < 500, "abort should end the backoff wait promptly");
	assert.equal(callCount(), 1);
});

test("default classifierRetry config is 3 attempts with 1s base delay", () => {
	const config = buildEffectiveConfigFromSources({});
	assert.deepEqual(config.classifierRetry, { maxAttempts: 3, baseDelayMs: 1000 });
	assert.deepEqual(config.classifierRetry, DEFAULT_CLASSIFIER_RETRY);
});

test("classifierRetry merges field-wise across scopes", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierRetry: { maxAttempts: 5 } } }],
		projectLocalSettings: [{ autoMode: { classifierRetry: { baseDelayMs: 250 } } }],
	});
	assert.deepEqual(config.classifierRetry, { maxAttempts: 5, baseDelayMs: 250 });
});

test("invalid classifierRetry values fall back to defaults and surface diagnostics", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [
			{ autoMode: { classifierRetry: { maxAttempts: 0, baseDelayMs: "soon" } } } as never,
		],
	});
	assert.deepEqual(config.classifierRetry, DEFAULT_CLASSIFIER_RETRY);

	const diagnostics = validateSettingsFile(
		{
			autoMode: {
				classifierRetry: { maxAttempts: 0, baseDelayMs: "soon", bogus: 1 },
			},
		} as never,
		"test.json",
	);
	const retryDiagnostics = diagnostics.filter((d) => d.includes("classifierRetry"));
	assert.equal(retryDiagnostics.length, 3);
	assert.ok(retryDiagnostics.some((d) => d.includes("maxAttempts")));
	assert.ok(retryDiagnostics.some((d) => d.includes("baseDelayMs")));
	assert.ok(retryDiagnostics.some((d) => d.includes("bogus")));
});

test("retry helpers: blacklist matching and backoff math", () => {
	assert.equal(isNonRetryableClassifierError("HTTP 401 from provider"), true);
	assert.equal(isNonRetryableClassifierError("insufficient_quota"), true);
	// Transient markers override quota-flavored codes from proxy gateways.
	assert.equal(isNonRetryableClassifierError(OPENROUTER_SHARED_POOL_429), false);
	assert.equal(
		isNonRetryableClassifierError("insufficient_quota — temporarily rate-limited upstream"),
		false,
	);
	assert.equal(
		isNonRetryableClassifierError("quota exceeded, please retry shortly"),
		false,
	);
	assert.equal(isNonRetryableClassifierError("Unsupported parameter: temperature"), true);
	assert.equal(isNonRetryableClassifierError("该客户端不支持"), true);
	assert.equal(isNonRetryableClassifierError("500 Internal Server Error"), false);
	assert.equal(isNonRetryableClassifierError("Request timed out."), false);
	assert.equal(isNonRetryableClassifierError("socket hang up"), false);

	assert.equal(classifierRetryDelayMs(1, 1000), 1000);
	assert.equal(classifierRetryDelayMs(2, 1000), 2000);
	assert.equal(classifierRetryDelayMs(3, 1000), 4000);
});

test("waitForClassifierRetry resolves false when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	assert.equal(await waitForClassifierRetry(50, controller.signal), false);
	assert.equal(await waitForClassifierRetry(0, undefined), true);
});
