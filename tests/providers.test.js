"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/providers.js");
const { defaults, defaultPrompt, hostPermissionPattern, validateConfig, listModels, summarize } = globalThis.TLDRProviders;

function config(provider, overrides = {}) {
  return { provider, baseUrl: defaults[provider].baseUrl, apiKey: provider === "ollama" ? "" : "secret-key", model: "test-model", prompt: "  Custom prompt\nexactly  ", ...overrides };
}

const source = { title: "Title", url: "https://example.com/article", text: "The page text.", wordCount: 120 };
function mockFetch(t, replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options.body && JSON.parse(options.body) });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("Unexpected fetch");
    return { ok: reply.status === undefined || reply.status < 400, status: reply.status || 200, json: async () => {
      if (reply.invalid) throw new SyntaxError("invalid");
      return reply.data;
    } };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("configuration validates provider, URLs, keys and model", () => {
  assert.equal(typeof defaultPrompt, "string");
  assert.equal(Object.keys(defaults).length, 6);
  assert.throws(() => validateConfig({ provider: "constructor" }), /provider/i);
  assert.throws(() => validateConfig(config("openai", { baseUrl: "https://user:password@example.com/v1" })), /credentials/i);
  assert.throws(() => validateConfig(config("openai", { baseUrl: "https://example.com/v1?token=abc" })), /query/i);
  assert.throws(() => validateConfig(config("openai", { baseUrl: "file:///tmp/model" })), /HTTP or HTTPS/i);
  assert.throws(() => validateConfig(config("openai", { baseUrl: "http://example.com" })), /HTTPS.*loopback/i);
  assert.throws(() => validateConfig(config("openai", { apiKey: "" })), /key/i);
  assert.throws(() => validateConfig(config("openai", { apiKey: "abc\ndef" })), /line breaks/i);
  assert.throws(() => validateConfig(config("ollama", { model: " " })), /model/i);
  assert.equal(validateConfig(config("ollama", { baseUrl: "http://127.0.0.1:11434/prefix/", model: "" }), { requireModel: false }).baseUrl, "http://127.0.0.1:11434/prefix");
  assert.equal(validateConfig(config("ollama")).apiKey, "");
});

test("HTTP is restricted to canonical loopback hosts", () => {
  const allowed = [
    ["http://LOCALHOST:3000/api", "http://localhost:3000/api", "http://localhost/*"],
    ["http://%6cocalhost/api", "http://localhost/api", "http://localhost/*"],
    ["http://127.0.0.0", "http://127.0.0.0", "http://127.0.0.0/*"],
    ["http://127.255.255.255", "http://127.255.255.255", "http://127.255.255.255/*"],
    ["http://127.1:9000/api", "http://127.0.0.1:9000/api", "http://127.0.0.1/*"],
    ["http://2130706433", "http://127.0.0.1", "http://127.0.0.1/*"],
    ["http://0x7f000001", "http://127.0.0.1", "http://127.0.0.1/*"],
    ["http://0177.0.0.01", "http://127.0.0.1", "http://127.0.0.1/*"],
    ["http://127.0.0.1.", "http://127.0.0.1", "http://127.0.0.1/*"],
    ["http://[0:0:0:0:0:0:0:1]:11434/api", "http://[::1]:11434/api", "http://[::1]/*"]
  ];
  for (const [url, normalized, pattern] of allowed) {
    assert.equal(validateConfig(config("openai", { baseUrl: url })).baseUrl, normalized, url);
    assert.equal(hostPermissionPattern(url), pattern, url);
  }
  const rejected = [
    "http://example.com", "http://localhost.evil", "http://evil.localhost", "http://localhost.",
    "http://localhost-evil", "http://127.0.0.1.evil", "http://127.example.com", "http://127.0.0.1.localhost",
    "http://126.255.255.255", "http://128.0.0.0", "http://192.168.1.1", "http://10.0.0.1",
    "http://172.16.0.1", "http://169.254.1.1", "http://0.0.0.0", "http://0xc0a80101",
    "http://[::]", "http://[::2]", "http://[fe80::1]", "http://[fc00::1]",
    "http://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]"
  ];
  for (const url of rejected) {
    assert.throws(() => validateConfig(config("openai", { baseUrl: url })), /HTTPS.*loopback/i, url);
    assert.throws(() => hostPermissionPattern(url), /HTTPS.*loopback/i, url);
    const httpsUrl = url.replace(/^http:/, "https:");
    assert.doesNotThrow(() => validateConfig(config("openai", { baseUrl: httpsUrl })), httpsUrl);
    assert.doesNotThrow(() => hostPermissionPattern(httpsUrl), httpsUrl);
  }
});

test("insecure remote endpoints are rejected before requests", async t => {
  const calls = mockFetch(t, []);
  const cfg = config("openai", { baseUrl: "http://192.168.1.1/api" });
  await assert.rejects(listModels(cfg), /HTTPS.*loopback.*manually/i);
  await assert.rejects(summarize(cfg, source), /HTTPS.*loopback/i);
  assert.equal(calls.length, 0);
});

test("base URL validation and permission patterns allow only specific hosts", () => {
  const valid = [
    ["http://localhost:11434/api", "http://localhost/*"],
    ["http://127.0.0.1:9000/prefix", "http://127.0.0.1/*"],
    ["http://[::1]:11434/api", "http://[::1]/*"],
    ["https://api.openai.com/v1", "https://api.openai.com/*"],
    ["https://münich.example:8443/custom", "https://xn--mnich-kva.example/*"],
    ["https://some_host.example./custom", "https://some_host.example./*"]
  ];
  for (const [url, pattern] of valid) {
    assert.equal(hostPermissionPattern(url), pattern);
    assert.doesNotThrow(() => validateConfig(config("openai", { baseUrl: url })));
  }
  const invalid = [
    "https://*", "https://*.example.com", "https://%2a", "https://%2A.example.com",
    "https://a*b.com", "https://exa mple.com", "http://*:11434", "https://a..example.com",
    "https://example.com/*/v1", "https://example.com/%2a/v1", "https://example.com/path%2A",
    "https://example.com/path?test=*", "https://example.com/path#%2a",
    "https://example.com/%2\na"
  ];
  for (const url of invalid) {
    assert.throws(() => hostPermissionPattern(url), Error, url);
    assert.throws(() => validateConfig(config("openai", { baseUrl: url })), Error, url);
  }
  for (const url of ["https://user:pass@example.com", "https://example.com/?q=1", "https://example.com/#frag", "https://example.com/?", "https://example.com/#", "file:///tmp/test", "not a url"]) {
    assert.throws(() => hostPermissionPattern(url), Error, url);
  }
});

test("OpenAI-compatible discovery and summaries use custom base paths", async t => {
  for (const provider of ["openai", "openrouter", "openwebui"]) {
    await t.test(provider, async t => {
      const calls = mockFetch(t, [
        { data: { data: [{ id: "one" }, { id: "two" }, { id: "one" }] } },
        { data: { choices: [{ message: { content: " Summary " } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } }
      ]);
      const cfg = config(provider, { baseUrl: "https://example.com/custom/v1/" });
      assert.deepEqual(await listModels({ ...cfg, model: "" }), ["one", "two"]);
      const signal = new AbortController().signal;
      assert.deepEqual(await summarize(cfg, source, signal), { text: "Summary", usage: { input: 10, output: 3, total: 13 }, warning: null });
      assert.equal(calls[0].url, "https://example.com/custom/v1/models");
      assert.equal(calls[1].url, "https://example.com/custom/v1/chat/completions");
      assert.equal(calls[1].options.headers.Authorization, "Bearer secret-key");
      assert.equal(calls[1].options.signal, signal);
      assert.equal(calls[1].options.redirect, "error");
      assert.equal(calls[1].options.credentials, "omit");
      assert.ok(calls[1].body.messages[0].content.includes(cfg.prompt));
      assert.match(calls[1].body.messages[0].content, /untrusted/i);
      assert.ok(calls[1].body.messages[1].content.includes(source.text));
      assert.match(calls[1].body.messages[1].content, /Source word count: 120/);
    });
  }
});

test("Anthropic paginates models and sends messages with API headers", async t => {
  const calls = mockFetch(t, [
    { data: { data: [{ id: "claude-a" }], has_more: true, last_id: "a/+" } },
    { data: { data: [{ id: "claude-b" }], has_more: false } },
    { data: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "First" }, { type: "text", text: "Second" }], usage: { input_tokens: 9, output_tokens: 4 } } }
  ]);
  const cfg = config("anthropic");
  assert.deepEqual(await listModels(cfg), ["claude-a", "claude-b"]);
  assert.match(calls[1].url, /after_id=a%2F%2B$/);
  assert.deepEqual(await summarize(cfg, source), { text: "First\nSecond", usage: { input: 9, output: 4, total: 13 }, warning: null });
  assert.equal(calls[2].url, `${cfg.baseUrl}/messages`);
  assert.equal(calls[2].options.headers["x-api-key"], cfg.apiKey);
  assert.equal(calls[2].options.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[2].options.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(calls[2].body.max_tokens, 4096);
  assert.ok(calls[2].body.system.includes(cfg.prompt));
  assert.equal(calls[2].body.messages[0].role, "user");
});

test("awaits preflight immediately before every discovery page and summary", async t => {
  const calls = mockFetch(t, [
    { data: { data: [{ id: "one" }], has_more: true, last_id: "one" } },
    { data: { data: [{ id: "two" }], has_more: false } },
    { data: { content: [{ type: "text", text: "summary" }], stop_reason: "end_turn" } }
  ]);
  let checks = 0;
  const beforeRequest = async () => {
    assert.equal(calls.length, checks);
    await Promise.resolve();
    assert.equal(calls.length, checks);
    checks++;
  };
  const cfg = config("anthropic");
  assert.deepEqual(await listModels(cfg, { beforeRequest }), ["one", "two"]);
  assert.equal((await summarize(cfg, source, undefined, { beforeRequest })).text, "summary");
  assert.equal(checks, 3);
  assert.equal(calls.length, 3);
});

test("preflight rejection stops discovery and summary requests", async t => {
  const calls = mockFetch(t, [
    { data: { data: [{ id: "one" }], has_more: true, last_id: "one" } }
  ]);
  const denied = new Error("Consent was revoked");
  let checks = 0;
  const beforeRequest = async () => {
    if (++checks === 2) throw denied;
  };
  await assert.rejects(listModels(config("anthropic"), { beforeRequest }), error =>
    /Consent was revoked/.test(error.message) && !/Could not reach|CORS/.test(error.message));
  assert.equal(checks, 2);
  assert.equal(calls.length, 1);
  await assert.rejects(summarize(config("openai"), source, undefined, { beforeRequest: () => { throw denied; } }), error => error === denied);
  assert.equal(calls.length, 1);
  await assert.rejects(listModels(config("openai"), { beforeRequest: async () => { throw denied; } }), /Consent was revoked/);
  assert.equal(calls.length, 1);
});

test("Gemini paginates, filters non-generative models, and parses candidates", async t => {
  const calls = mockFetch(t, [
    { data: { models: [{ name: "models/gemini-one", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next/+" } },
    { data: { models: [{ name: "models/gemini-two", supportedGenerationMethods: ["generateContent"] }] } },
    { data: { candidates: [{ content: { parts: [{ text: "reasoning", thought: true }, { text: "Gemini summary" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 13 } } }
  ]);
  const cfg = config("gemini", { model: "models/gemini/unsafe?" });
  assert.deepEqual(await listModels(cfg), ["gemini-one", "gemini-two"]);
  assert.match(calls[1].url, /pageToken=next%2F%2B$/);
  assert.deepEqual(await summarize(cfg, source), { text: "Gemini summary", usage: { input: 5, output: 6, total: 13 }, warning: null });
  assert.equal(calls[2].url, `${cfg.baseUrl}/models/gemini%2Funsafe%3F:generateContent`);
  assert.equal(calls[2].options.headers["x-goog-api-key"], cfg.apiKey);
  assert.ok(calls[2].body.systemInstruction.parts[0].text.includes(cfg.prompt));
});

test("Ollama discovery and full context with no truncation or shifting", async t => {
  const calls = mockFetch(t, [
    { data: { models: [{ name: "llama:latest" }, { model: "other" }] } },
    { data: { message: { content: "Local summary" }, prompt_eval_count: 20, eval_count: 8, done: true } }
  ]);
  const cfg = config("ollama", { baseUrl: "http://localhost:11434/prefix" });
  assert.deepEqual(await listModels(cfg), ["llama:latest", "other"]);
  const longSource = { ...source, text: "é".repeat(50000) };
  assert.deepEqual(await summarize(cfg, longSource), { text: "Local summary", usage: { input: 20, output: 8, total: 28 }, warning: null });
  assert.equal(calls[0].url, "http://localhost:11434/prefix/api/tags");
  assert.equal(calls[1].url, "http://localhost:11434/prefix/api/chat");
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].body.stream, false);
  assert.equal(calls[1].body.truncate, false);
  assert.equal(calls[1].body.shift, false);
  const bytes = new TextEncoder().encode(calls[1].body.messages.map(m => m.content).join("")).length;
  assert.ok(calls[1].body.options.num_ctx >= bytes + 8192);
  assert.ok(calls[1].body.messages[1].content.includes(longSource.text));
});

test("discovery failures give manual fallback and redact keys", async t => {
  const calls = mockFetch(t, [
    { status: 401, data: { error: { message: "Bad secret-key credential" } } },
    { data: { data: [] } },
    { data: { data: [{ id: "a" }], has_more: true, last_id: "same" } },
    { data: { data: [{ id: "b" }], has_more: true, last_id: "same" } }
  ]);
  await assert.rejects(listModels(config("openai")), error => /401/.test(error.message) && /manually/.test(error.message) && !error.message.includes("secret-key"));
  await assert.rejects(listModels(config("openai")), /No models.*manually/i);
  await assert.rejects(listModels(config("anthropic")), /pagination.*manually/i);
  assert.equal(calls.length, 4);
});

test("API and network failures are informative and do not expose keys", async t => {
  mockFetch(t, [
    { status: 429, data: { error: { message: "Rate limit for secret-key" } } },
    new Error("Network failed for secret-key"),
    { status: 500, invalid: true },
    { data: { choices: [] } }
  ]);
  const cfg = config("openai");
  await assert.rejects(summarize(cfg, source), e => /429.*Rate limit/.test(e.message) && !e.message.includes(cfg.apiKey));
  await assert.rejects(summarize(cfg, source), e => /network failed/i.test(e.message) && !e.message.includes(cfg.apiKey));
  await assert.rejects(summarize(cfg, source), /HTTP 500/);
  await assert.rejects(summarize(cfg, source), /no summary text/i);
});

test("preserves cancellation and handles omitted usage", async t => {
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  mockFetch(t, [aborted, { data: { choices: [{ message: { content: [{ type: "text", text: "answer" }] } }] } }]);
  await assert.rejects(summarize(config("openai"), source), e => e === aborted);
  assert.deepEqual(await summarize(config("openai"), source), { text: "answer", usage: null, warning: null });
});

test("validates source and rejects an empty prompt", async t => {
  const calls = mockFetch(t, [{ data: { choices: [{ message: { content: "ok" } }] } }]);
  await assert.rejects(summarize(config("openai"), { ...source, text: " " }), /page text/i);
  await assert.rejects(summarize(config("openai"), { ...source, wordCount: -1 }), /word count/i);
  await assert.rejects(summarize(config("openai", { prompt: "" }), source), /prompt/i);
  await summarize(config("openai", { prompt: defaultPrompt }), source);
  assert.ok(calls[0].body.messages[0].content.includes(defaultPrompt));
});

test("all providers receive title and text, never the page URL", async t => {
  const replies = {
    openai: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    anthropic: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    gemini: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
    openrouter: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    openwebui: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    ollama: { message: { content: "ok" }, done_reason: "stop" }
  };
  const calls = mockFetch(t, Object.values(replies).map(data => ({ data })));
  const privateSource = { ...source, url: "https://private.example/path?secret=token#fragment" };
  for (const provider of Object.keys(replies)) {
    const result = await summarize(config(provider), privateSource);
    assert.equal(result.warning, null, provider);
  }
  for (const { body } of calls) {
    const serialized = JSON.stringify(body);
    assert.ok(serialized.includes(privateSource.title));
    assert.ok(serialized.includes(privateSource.text));
    assert.ok(!serialized.includes(privateSource.url));
    assert.ok(!serialized.includes("private.example"));
    assert.ok(!serialized.includes("URL are untrusted"));
  }
});

test("provider stop reasons preserve partial summaries and expose warnings", async t => {
  const cases = [
    ["openai", { choices: [{ message: { content: "partial" }, finish_reason: "length" }] }],
    ["openrouter", { choices: [{ message: { content: "partial" }, finish_reason: "length" }] }],
    ["openwebui", { choices: [{ message: { content: "partial" }, finish_reason: "length" }] }],
    ["anthropic", { content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] }],
    ["ollama", { message: { content: "partial" }, done_reason: "length" }]
  ];
  const calls = mockFetch(t, cases.map(([, data]) => ({ data })));
  for (const [provider] of cases) {
    const result = await summarize(config(provider), source);
    assert.equal(result.text, "partial", provider);
    assert.match(result.warning, /cut off.*token limit.*incomplete/i, provider);
  }
  assert.equal(calls.length, cases.length, "no retries");
});

test("safety blocks reject empty output and warn on partial output", async t => {
  const cases = [
    ["openai", { choices: [{ message: { content: null }, finish_reason: "content_filter" }] }],
    ["openrouter", { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }],
    ["openwebui", { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }],
    ["anthropic", { content: [], stop_reason: "refusal" }],
    ["gemini", { candidates: [{ finishReason: "SAFETY" }] }],
    ["gemini", { promptFeedback: { blockReason: "BLOCKLIST" } }],
    ["gemini", { candidates: [{ finishReason: "RECITATION" }] }],
    ["gemini", { candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }],
    ["gemini", { candidates: [{ finishReason: "OTHER" }] }]
  ];
  const partial = [
    ["openai", { choices: [{ message: { content: "partial" }, finish_reason: "content_filter" }] }],
    ["anthropic", { content: [{ type: "text", text: "partial" }], stop_reason: "refusal" }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "STOP" }], promptFeedback: { blockReason: "SAFETY" } }]
  ];
  const calls = mockFetch(t, [...cases, ...partial].map(([, data]) => ({ data })));
  for (const [provider] of cases) await assert.rejects(summarize(config(provider), source), /blocked/i, provider);
  for (const [provider] of partial) {
    const result = await summarize(config(provider), source);
    assert.equal(result.text, "partial");
    assert.match(result.warning, /blocked/i);
  }
  assert.equal(calls.length, cases.length + partial.length);
});

test("unknown stop reasons are sanitized and missing reasons have no warning", async t => {
  const cases = [
    ["openai", { choices: [{ message: { content: "ok" }, finish_reason: `custom\nsecret-key${"x".repeat(100)}` }] }],
    ["anthropic", { content: [{ type: "text", text: "ok" }], stop_reason: "tool_use" }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "UNRECOGNIZED" }] }],
    ["ollama", { message: { content: "ok" }, done_reason: "unrecognized" }]
  ];
  mockFetch(t, [...cases.map(([, data]) => ({ data })), { data: { content: [{ type: "text", text: "ok" }], stop_reason: "stop_sequence" } }, { data: { message: { content: "ok" } } }]);
  for (const [provider] of cases) {
    const { warning } = await summarize(config(provider), source);
    assert.match(warning, /unrecognized reason/i);
    assert.doesNotMatch(warning, /[\r\n]|secret-key/);
    assert.ok(warning.match(/\((.*?)\)/)[1].length <= 40);
  }
  assert.equal((await summarize(config("anthropic"), source)).warning, null);
  assert.equal((await summarize(config("ollama"), source)).warning, null);
});
