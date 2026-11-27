'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const defaultPrompt = 'Summarize the main points accurately and concisely.';
const copy = value => JSON.parse(JSON.stringify(value));
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, description) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function page(title, text, wordCount = 400) {
  return { title, url: `https://example.com/${title}`, text, wordCount, truncated: false };
}

function makeBackground(options = {}) {
  const state = { entries: copy(options.entries || []), config: copy(options.config || { prompt: defaultPrompt }) };
  const writes = [];
  const listeners = {};
  const pages = new Map();
  const scriptCalls = [];
  const calls = [];
  const timers = new Map();
  const intervals = new Map();
  const heartbeats = [];
  const validations = [];
  const checks = [];
  const panelOpens = [];
  const consent = { granted: options.granted !== false, supported: options.supported !== false };
  let nextId = 0;
  let nextTimer = 0;
  let now = 1000;
  const on = name => ({ addListener(fn) { listeners[name] = fn; } });

  const ext = {
    action: { onClicked: on('click') },
    commands: { onCommand: on('command') },
    runtime: { id: 'extension-id', getURL(path) { return `extension://${path}`; }, onConnect: on('connect'), onMessage: on('message'), onStartup: on('startup'), onInstalled: on('installed'), ...(options.firefox ? { getBrowserInfo() {}, getPlatformInfo() { heartbeats.push(true); return options.heartbeatError ? Promise.reject(new Error('unavailable')) : Promise.resolve({}); } } : {}) },
    permissions: {
      async getAll() { if (options.permissionError) throw new Error('unsupported'); return consent.supported ? { data_collection: consent.granted ? ['authenticationInfo'] : [] } : {}; },
      async contains(request) { checks.push(copy(request)); return consent.granted; }
    },
    ...(options.chromePanel ? { sidePanel: { open(details) { panelOpens.push(copy(details)); } } } : {
      sidebarAction: { open() { panelOpens.push('firefox'); } },
      extension: { getViews(filter) { assert.equal(filter.type, 'sidebar'); return options.views || []; } }
    }),
    tabs: { async query() { return options.query ? options.query() : []; } },
    scripting: {
      async executeScript(details) {
        scriptCalls.push({ tabId: details.target.tabId, args: copy(details.args) });
        const result = await pages.get(details.target.tabId);
        if (result instanceof Error) throw result;
        return [{ result: copy(result) }];
      }
    },
    storage: { local: {
      async get(key) { return { [key]: state[key] === undefined ? undefined : copy(state[key]) }; },
      async set(values) {
        Object.assign(state, copy(values));
        writes.push(copy(values));
        if (options.onSet) await options.onSet(values);
      }
    } }
  };
  const providers = {
    defaultPrompt,
    validateConfig(config) {
      validations.push(copy(config));
      if (options.validationError) throw new Error(options.validationError);
      if (typeof config.prompt !== 'string' || !config.prompt.trim()) throw new Error('Enter a custom prompt or restore the default.');
      return config;
    },
    async summarize(config, job, signal, { beforeRequest }) {
      if (options.beforeProviderRequest) await options.beforeProviderRequest(consent);
      await beforeRequest();
      const result = deferred();
      calls.push({ config: copy(config), job: copy(job), signal, ...result });
      if (!options.ignoreAbort) {
        const abort = () => result.reject(new Error('Aborted'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      return result.promise;
    }
  };
  class FakeDate extends Date { static now() { return now; } }
  vm.runInNewContext(source, {
    browser: ext,
    TLDRProviders: providers,
    AbortController,
    Date: FakeDate,
    crypto: { randomUUID: () => `id-${++nextId}` },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++nextTimer; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }
  }, { filename: 'background.js' });

  function send(message, sender = { id: 'extension-id' }) {
    const reply = deferred();
    const accepted = listeners.message(message, sender, reply.resolve);
    return { accepted, reply: reply.promise };
  }
  return {
    state, writes, pages, scriptCalls, calls, timers, intervals, heartbeats, validations, listeners, send, checks, consent, panelOpens,
    click(id, details = {}) { listeners.click({ id, title: `tab-${id}`, url: `https://example.com/tab-${id}`, ...details }); },
    advance(ms) { now += ms; },
    fireTimeout(delay = 120000) {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, delay);
      timers.delete(id);
      timer.fn();
    }
  };
}

test('Firefox reuses an existing sidebar while capturing the invoked tab', async () => {
  const views = [{}];
  const bg = makeBackground({ firefox: true, views });
  bg.pages.set(1, page('toolbar', 'toolbar text'));
  bg.pages.set(2, page('shortcut', 'shortcut text'));
  bg.click(1, { windowId: 2 });
  bg.listeners.command('summarize', { id: 2, windowId: 2 });
  await waitFor(() => bg.state.entries.length === 2, 'both captures');
  assert.deepEqual(bg.panelOpens, []);
  assert.deepEqual(bg.scriptCalls.map(call => call.tabId), [1, 2]);
  views.pop();
  bg.click(1, { windowId: 2 });
  assert.deepEqual(bg.panelOpens, ['firefox']);
});

test('Chrome reuses connected panels and opens again after the last disconnect', async () => {
  const bg = makeBackground({ chromePanel: true });
  const disconnects = [];
  const port = { name: 'sidebar', sender: { id: 'extension-id', url: 'extension://src/sidebar.html' }, onDisconnect: { addListener(fn) { disconnects.push(fn); } } };
  bg.pages.set(1, page('toolbar', 'toolbar text'));
  bg.pages.set(2, page('shortcut', 'shortcut text'));
  bg.listeners.connect(port);
  bg.click(1, { windowId: 2 });
  bg.listeners.command('summarize', { id: 2, windowId: 2 });
  await waitFor(() => bg.state.entries.length === 2, 'both captures');
  assert.deepEqual(bg.panelOpens, []);
  assert.deepEqual(bg.scriptCalls.map(call => call.tabId), [1, 2]);
  disconnects[0]();
  bg.click(1, { windowId: 2 });
  assert.deepEqual(bg.panelOpens, [{ windowId: 2 }]);
});

test('captures concurrent invocations immediately and processes persisted jobs sequentially', async () => {
  const bg = makeBackground();
  bg.pages.set(1, page('first', 'first original'));
  bg.pages.set(2, page('second', 'second original'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'first provider call');
  bg.click(2);
  bg.pages.set(2, page('second', 'second changed after invocation'));
  await waitFor(() => bg.state.entries.length === 2, 'second capture');

  assert.deepEqual(bg.scriptCalls, [{ tabId: 1, args: [60000] }, { tabId: 2, args: [60000] }]);
  assert.equal(bg.calls.length, 1);
  assert.equal(bg.state.entries[0].status, 'running');
  assert.equal(bg.state.entries[1].status, 'queued');
  assert.equal(bg.state.entries[1].text, 'second original');
  assert.ok(bg.writes.some(write => write.entries?.some(entry => entry.title === 'second' && entry.status === 'queued' && entry.text === 'second original')));

  bg.advance(37);
  bg.calls[0].resolve({ text: 'first summary', usage: { input: 4, output: 2, total: 6 } });
  await waitFor(() => bg.calls.length === 2, 'second provider call');
  assert.equal(bg.calls[1].job.text, 'second original');
  assert.equal(bg.calls[1].job.status, 'running');
  assert.equal(bg.state.entries[0].summary, 'first summary');
  assert.deepEqual(bg.state.entries[0].usage, { input: 4, output: 2, total: 6 });
  assert.equal(bg.state.entries[0].elapsedMs, 37);
  assert.equal('text' in bg.state.entries[0], false);

  bg.advance(13);
  bg.calls[1].resolve({ text: 'second summary', usage: null });
  await waitFor(() => bg.state.entries[1].status === 'done', 'second persisted result');
  assert.equal(bg.state.entries[1].summary, 'second summary');
  assert.equal(bg.state.entries[1].usage, null);
  assert.equal(bg.state.entries[1].elapsedMs, 13);
  assert.equal('text' in bg.state.entries[1], false);
  await waitFor(() => bg.timers.size === 0, 'cleared request timers');
});

test('Firefox checks consent for every queued keyed request and honors revocation', async () => {
  const bg = makeBackground({ firefox: true, config: { prompt: defaultPrompt, apiKey: 'secret' } });
  bg.pages.set(1, page('first', 'first text'));
  bg.pages.set(2, page('second', 'second text'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'first authorized request');
  bg.click(2);
  await waitFor(() => bg.state.entries.length === 2, 'second queued request');
  bg.consent.granted = false;
  bg.calls[0].resolve({ text: 'first summary', usage: null });
  await waitFor(() => bg.state.entries[1].status === 'error', 'revoked queued request');
  assert.equal(bg.calls.length, 1);
  assert.match(bg.state.entries[1].error, /authentication information permission.*Settings/i);
  assert.ok(bg.checks.length >= 2);
  assert.deepEqual(bg.checks[0], { data_collection: ['authenticationInfo'] });
});

test('Firefox fails closed for missing, denied, or broken consent APIs', async () => {
  for (const scenario of [{ granted: false }, { supported: false }, { permissionError: true }]) {
    const bg = makeBackground({ firefox: true, config: { prompt: defaultPrompt, apiKey: 'secret' }, ...scenario });
    bg.pages.set(1, page('page', 'text'));
    bg.click(1);
    await waitFor(() => bg.state.entries[0]?.status === 'error', 'consent error');
    assert.equal(bg.calls.length, 0);
    assert.match(bg.state.entries[0].error, /authentication information permission/i);
  }
});

test('Firefox rechecks before fetch and detects revocation after queue preflight', async () => {
  const bg = makeBackground({ firefox: true, config: { prompt: defaultPrompt, apiKey: 'secret' }, beforeProviderRequest(consent) { consent.granted = false; } });
  bg.pages.set(1, page('page', 'text'));
  bg.click(1);
  await waitFor(() => bg.state.entries[0]?.status === 'error', 'revoked provider preflight');
  assert.equal(bg.calls.length, 0);
  assert.match(bg.state.entries[0].error, /authentication information permission/i);
});

test('Firefox short-page skip and keyless Ollama do not require consent; Chrome remains unchanged', async () => {
  const short = makeBackground({ firefox: true, granted: false, config: { prompt: defaultPrompt, apiKey: 'secret' } });
  short.pages.set(1, page('short', 'text', 2));
  short.click(1);
  await waitFor(() => short.state.entries[0]?.status === 'done', 'short-page skip');
  assert.equal(short.checks.length, 0);
  for (const scenario of [{ firefox: true, apiKey: '' }, { firefox: false, apiKey: 'secret' }]) {
    const bg = makeBackground({ ...scenario, granted: false, config: { prompt: defaultPrompt, apiKey: scenario.apiKey } });
    bg.pages.set(1, page('page', 'text'));
    bg.click(1);
    await waitFor(() => bg.calls.length === 1, 'keyless or Chrome request');
    assert.equal(bg.checks.length, 0);
    bg.calls[0].resolve({ text: 'summary', usage: null });
    await waitFor(() => bg.state.entries[0]?.status === 'done', 'summary saved');
  }
});

test('deleting queued and running work does not resurrect it or interrupt other work', async () => {
  const bg = makeBackground({ ignoreAbort: true });
  for (let id = 1; id <= 3; id++) bg.pages.set(id, page(`page-${id}`, `text-${id}`));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'first request');
  bg.click(2);
  bg.click(3);
  await waitFor(() => bg.state.entries.length === 3, 'queued captures');
  const [first, second, third] = bg.state.entries.map(entry => entry.id);

  const queuedDelete = bg.send({ type: 'delete', id: second });
  assert.equal(queuedDelete.accepted, true);
  assert.deepEqual(copy(await queuedDelete.reply), { ok: true });
  assert.equal(bg.calls[0].signal.aborted, false);
  assert.deepEqual(bg.state.entries.map(entry => entry.id), [first, third]);

  const activeDelete = bg.send({ type: 'delete', id: first });
  assert.equal(activeDelete.accepted, true);
  assert.equal(bg.calls[0].signal.aborted, true);
  assert.deepEqual(copy(await activeDelete.reply), { ok: true });
  bg.calls[0].resolve({ text: 'late result', usage: null });
  await waitFor(() => bg.calls.length === 2, 'remaining request');
  assert.equal(bg.calls[1].job.id, third);
  assert.deepEqual(bg.state.entries.map(entry => entry.id), [third]);
  bg.calls[1].resolve({ text: 'remaining summary', usage: null });
  await waitFor(() => bg.state.entries[0]?.status === 'done', 'remaining result');
  assert.equal(bg.state.entries[0].summary, 'remaining summary');
  assert.deepEqual(bg.state.entries.map(entry => entry.id), [third]);
});

test('deleteAll aborts active work and late results cannot restore history', async () => {
  const bg = makeBackground({ ignoreAbort: true });
  bg.pages.set(1, page('first', 'first text'));
  bg.pages.set(2, page('second', 'second text'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'active request');
  bg.click(2);
  await waitFor(() => bg.state.entries.length === 2, 'queued request');
  const deletion = bg.send({ type: 'deleteAll' });
  assert.equal(deletion.accepted, true);
  assert.equal(bg.calls[0].signal.aborted, true);
  assert.deepEqual(copy(await deletion.reply), { ok: true });
  const writesAtDeletion = bg.writes.length;
  bg.calls[0].resolve({ text: 'late result', usage: null });
  await waitFor(() => bg.writes.length > writesAtDeletion, 'late request persistence');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bg.state.entries, []);
  assert.equal(bg.calls.length, 1);
});

test('default prompt skips pages below 350 words but not the boundary', async () => {
  const bg = makeBackground();
  bg.pages.set(1, page('short', 'short text', 349));
  bg.pages.set(2, page('boundary', 'boundary text', 350));
  bg.click(1);
  await waitFor(() => bg.state.entries[0]?.status === 'done', 'short page result');
  assert.equal(bg.calls.length, 0);
  assert.equal(bg.validations.length, 1);
  assert.equal(bg.state.entries[0].summary, 'This page contains approximately 349 words, fewer than 350. It was not summarized.');
  assert.equal(bg.state.entries[0].usage, null);
  assert.equal('text' in bg.state.entries[0], false);
  bg.click(2);
  await waitFor(() => bg.calls.length === 1, 'boundary provider call');
  assert.equal(bg.calls[0].job.wordCount, 350);
  bg.calls[0].resolve({ text: 'boundary summary', usage: null });
  await waitFor(() => bg.state.entries[1]?.status === 'done', 'boundary result');
});

test('custom prompt sends a short page to the provider', async () => {
  const bg = makeBackground({ config: { prompt: 'Extract the names.' } });
  bg.pages.set(1, page('short', 'Alice and Bob', 3));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'custom-prompt request');
  assert.equal(bg.calls[0].config.prompt, 'Extract the names.');
  assert.equal(bg.calls[0].job.text, 'Alice and Bob');
  bg.calls[0].resolve({ text: 'Alice, Bob', usage: { input: 3, output: 2, total: 5 } });
  await waitFor(() => bg.state.entries[0]?.status === 'done', 'custom-prompt result');
  assert.equal(bg.state.entries[0].summary, 'Alice, Bob');
  assert.deepEqual(bg.state.entries[0].usage, { input: 3, output: 2, total: 5 });
  assert.equal('text' in bg.state.entries[0], false);
});

test('recovers interrupted jobs and persists results in queue order', async () => {
  const entries = [
    { id: 'old-done', ...page('done', 'unused'), status: 'done', summary: 'saved', createdAt: 1 },
    { id: 'interrupted', ...page('interrupted', 'original interrupted text'), status: 'running', createdAt: 2 },
    { id: 'waiting', ...page('waiting', 'original waiting text'), status: 'queued', createdAt: 3 }
  ];
  const bg = makeBackground({ entries });
  await waitFor(() => bg.calls.length === 1, 'recovered request');
  assert.ok(bg.writes.some(write => write.entries?.find(entry => entry.id === 'interrupted')?.status === 'queued'));
  assert.equal(bg.calls[0].job.id, 'interrupted');
  assert.equal(bg.calls[0].job.text, 'original interrupted text');
  assert.equal(bg.state.entries[1].status, 'running');
  assert.equal(bg.state.entries[2].status, 'queued');
  bg.calls[0].resolve({ text: 'recovered summary', usage: null });
  await waitFor(() => bg.calls.length === 2, 'next recovered request');
  assert.equal(bg.calls[1].job.id, 'waiting');
  assert.equal(bg.calls[1].job.text, 'original waiting text');
  bg.calls[1].resolve({ text: 'waiting summary', usage: null });
  await waitFor(() => bg.state.entries[2].status === 'done', 'recovered queue completion');
  assert.equal(bg.state.entries[0].summary, 'saved');
  assert.equal(bg.state.entries[1].summary, 'recovered summary');
  assert.equal(bg.state.entries[2].summary, 'waiting summary');
  assert.equal('text' in bg.state.entries[1], false);
  assert.equal('text' in bg.state.entries[2], false);

  const restarted = makeBackground({ entries: bg.state.entries, config: bg.state.config });
  await waitFor(() => restarted.writes.length > 0, 'restart recovery');
  assert.deepEqual(restarted.state.entries, bg.state.entries);
  assert.equal(restarted.calls.length, 0);
});

test('timeouts and provider failures are persisted and do not stop the queue', async () => {
  const bg = makeBackground();
  for (let id = 1; id <= 2; id++) bg.pages.set(id, page(`page-${id}`, `text-${id}`));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'first request');
  bg.click(2);
  await waitFor(() => bg.state.entries.length === 2, 'second request queued');
  bg.advance(120000);
  bg.fireTimeout();
  assert.equal(bg.calls[0].signal.aborted, true);
  await waitFor(() => bg.calls.length === 2, 'request after timeout');
  assert.equal(bg.state.entries[0].status, 'error');
  assert.equal(bg.state.entries[0].error, 'The request timed out after 120 seconds.');
  assert.equal(bg.state.entries[0].elapsedMs, 120000);
  assert.equal('text' in bg.state.entries[0], false);
  bg.calls[1].reject(new Error('Provider unavailable'));
  await waitFor(() => bg.state.entries[1].status === 'error', 'provider failure');
  assert.equal(bg.state.entries[1].error, 'Provider unavailable');
  assert.equal('text' in bg.state.entries[1], false);
  assert.equal(bg.timers.size, 0);
});

test('slow Ollama requests can finish after two minutes and eventually time out', async () => {
  const bg = makeBackground({ config: { provider: 'ollama', prompt: defaultPrompt } });
  bg.pages.set(1, page('slow', 'text'));
  bg.pages.set(2, page('timeout', 'text'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'slow Ollama request');
  assert.equal([...bg.timers.values()][0].delay, 1800000);
  bg.advance(180000);
  assert.equal(bg.calls[0].signal.aborted, false);
  bg.calls[0].resolve({ text: 'slow summary', usage: null });
  await waitFor(() => bg.state.entries[0]?.status === 'done', 'slow summary');
  assert.equal(bg.state.entries[0].summary, 'slow summary');
  assert.equal(bg.state.entries[0].elapsedMs, 180000);

  bg.click(2);
  await waitFor(() => bg.calls.length === 2, 'second Ollama request');
  bg.advance(1800000);
  bg.fireTimeout(1800000);
  await waitFor(() => bg.state.entries[1]?.status === 'error', 'Ollama timeout');
  assert.equal(bg.state.entries[1].error, 'The request timed out after 1800 seconds.');
  assert.equal(bg.calls[1].signal.aborted, true);
});

test('Firefox keeps the background active during consecutive requests and stops when idle', async () => {
  const bg = makeBackground({ firefox: true, heartbeatError: true, config: { provider: 'ollama', prompt: defaultPrompt } });
  bg.pages.set(1, page('first', 'text'));
  bg.pages.set(2, page('second', 'text'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'first request');
  bg.click(2);
  await waitFor(() => bg.state.entries.length === 2, 'second queued request');
  assert.equal(bg.intervals.size, 1);
  const heartbeat = [...bg.intervals.values()][0];
  assert.equal(heartbeat.delay, 10000);
  heartbeat.fn();
  heartbeat.fn();
  assert.equal(bg.heartbeats.length, 2);
  bg.calls[0].resolve({ text: 'first', usage: null });
  await waitFor(() => bg.calls.length === 2, 'second request');
  assert.equal(bg.intervals.size, 1);
  heartbeat.fn();
  bg.calls[1].resolve({ text: 'second', usage: null });
  await waitFor(() => bg.state.entries[1]?.status === 'done' && bg.intervals.size === 0, 'queue idle');
  assert.equal(bg.heartbeats.length, 3);

  const chrome = makeBackground();
  chrome.pages.set(1, page('page', 'text'));
  chrome.click(1);
  await waitFor(() => chrome.calls.length === 1, 'Chrome request');
  assert.equal(chrome.intervals.size, 0);
  chrome.calls[0].resolve({ text: 'done', usage: null });
});

test('Firefox stops the keepalive after a running request is canceled', async () => {
  const bg = makeBackground({ firefox: true, config: { provider: 'ollama', prompt: defaultPrompt } });
  bg.pages.set(1, page('page', 'text'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'running request');
  assert.equal(bg.intervals.size, 1);
  await bg.send({ type: 'delete', id: bg.state.entries[0].id }).reply;
  await waitFor(() => bg.intervals.size === 0, 'keepalive stopped');
  assert.equal(bg.calls[0].signal.aborted, true);
  assert.deepEqual(bg.state.entries, []);
});

test('capture and validation failures are persisted without provider calls', async () => {
  const bg = makeBackground({ validationError: 'Invalid provider configuration' });
  bg.pages.set(1, new Error('Permission denied'));
  bg.pages.set(2, page('short', 'some text', 10));
  bg.click(1);
  await waitFor(() => bg.state.entries[0]?.status === 'error', 'capture error');
  assert.match(bg.state.entries[0].error, /Could not read this page/);
  assert.equal(bg.state.entries[0].title, 'Page unavailable');
  bg.click(2);
  await waitFor(() => bg.state.entries[1]?.status === 'error', 'configuration error');
  assert.equal(bg.state.entries[1].error, 'Invalid provider configuration');
  assert.equal('text' in bg.state.entries[1], false);
  assert.equal(bg.calls.length, 0);
});

test('ignores deletion messages from other extensions and unsupported messages', () => {
  const bg = makeBackground();
  assert.equal(bg.send({ type: 'deleteAll' }, { id: 'other-extension' }).accepted, false);
  assert.equal(bg.send({ type: 'unknown' }).accepted, false);
});

test('a blank prompt is rejected rather than sent to the provider', async () => {
  const bg = makeBackground({ config: { prompt: '   ' } });
  bg.pages.set(1, page('short', 'short text', 10));
  bg.click(1);
  await waitFor(() => bg.state.entries[0]?.status === 'error', 'configuration error');
  assert.equal(bg.calls.length, 0);
  assert.match(bg.state.entries[0].error, /prompt/i);
});

test('deleting a just-persisted running job prevents or aborts its request', async () => {
  const runningWrite = deferred();
  const releaseWrite = deferred();
  const bg = makeBackground({
    ignoreAbort: true,
    async onSet(values) {
      if (values.entries?.some(entry => entry.status === 'running')) {
        runningWrite.resolve();
        await releaseWrite.promise;
      }
    }
  });
  bg.pages.set(1, page('race', 'race text'));
  bg.click(1);
  await waitFor(() => bg.state.entries[0]?.status === 'running', 'running state persistence');
  await runningWrite.promise;
  const id = bg.state.entries[0].id;
  const deletion = bg.send({ type: 'delete', id });
  assert.equal(deletion.accepted, true);
  releaseWrite.resolve();
  assert.deepEqual(copy(await deletion.reply), { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  if (bg.calls.length) bg.calls[0].resolve({ text: 'late result', usage: null });
  assert.ok(bg.calls.length === 0 || bg.calls[0].signal.aborted, 'deleted work must not start an unabortable provider request');
  assert.deepEqual(bg.state.entries, []);
});

test('private tabs do not open the panel, capture, write entries, or contact providers', async () => {
  const bg = makeBackground();
  await waitFor(() => bg.writes.length >= 2, 'initial queue recovery');
  await new Promise(resolve => setImmediate(resolve));
  const writes = bg.writes.length;
  bg.pages.set(1, page('private', 'private text'));
  bg.click(1, { incognito: true });
  bg.listeners.command('summarize', { id: 1, incognito: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bg.scriptCalls.length, 0);
  assert.equal(bg.writes.length, writes);
  assert.deepEqual(bg.state.entries, []);
  assert.equal(bg.calls.length, 0);
});

test('deleteAll invalidates both successful and failed in-flight captures', async () => {
  const bg = makeBackground();
  const pending = deferred();
  const failing = deferred();
  bg.pages.set(1, pending.promise);
  bg.pages.set(2, failing.promise);
  bg.click(1);
  bg.click(2);
  await waitFor(() => bg.scriptCalls.length === 2, 'pending captures');
  assert.deepEqual(copy(await bg.send({ type: 'deleteAll' }).reply), { ok: true });
  pending.resolve(page('old', 'old text'));
  failing.resolve(new Error('failed with https://secret.example/#token'));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bg.state.entries, []);
  assert.equal(bg.calls.length, 0);
  bg.pages.set(3, page('new', 'new text'));
  bg.click(3);
  await waitFor(() => bg.calls.length === 1, 'new capture after deletion');
  bg.calls[0].resolve({ text: 'new summary', usage: null });
  await waitFor(() => bg.state.entries[0]?.status === 'done', 'new summary');
});

test('deleteAll invalidates a shortcut still resolving its active tab', async () => {
  const activeTab = deferred();
  const bg = makeBackground({ query: () => activeTab.promise });
  bg.pages.set(1, page('old', 'old text'));
  bg.listeners.command('summarize');
  assert.deepEqual(copy(await bg.send({ type: 'deleteAll' }).reply), { ok: true });
  activeTab.resolve([{ id: 1 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bg.scriptCalls.length, 0);
  assert.deepEqual(bg.state.entries, []);
  assert.equal(bg.calls.length, 0);
});

test('removes legacy URLs, never stores newly captured URLs, and persists warnings', async () => {
  const bg = makeBackground({ entries: [{ id: 'old', title: 'old', status: 'done', summary: 'saved', url: 'https://secret.example/?token=123' }] });
  await waitFor(() => bg.writes.length >= 2, 'URL migration');
  assert.equal('url' in bg.state.entries[0], false);
  bg.pages.set(1, page('new', 'content'));
  bg.click(1);
  await waitFor(() => bg.calls.length === 1, 'new provider call');
  assert.equal('url' in bg.calls[0].job, false);
  bg.calls[0].resolve({ text: 'partial', usage: null, warning: 'Output may be incomplete.' });
  await waitFor(() => bg.state.entries[1]?.status === 'done', 'warning stored');
  assert.equal('url' in bg.state.entries[1], false);
  assert.equal(bg.state.entries[1].warning, 'Output may be incomplete.');
});
