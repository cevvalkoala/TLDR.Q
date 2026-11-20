'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('../src/providers.js');

function makeOptions(options = {}) {
  const elements = new Map();
  const requests = [];
  const writes = [];
  const checks = [];
  const modelCalls = [];
  const consent = { granted: options.granted !== false, supported: options.supported !== false };
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false,
      classList: { toggle() {} },
      addEventListener(name, handler) { this[name] = handler; },
      replaceChildren() {}, append() {}
    });
    return elements.get(id);
  }
  const browser = {
    permissions: {
      request(request) { requests.push(request); return options.request ? options.request(request) : Promise.resolve(true); },
      async getAll() { return consent.supported ? { data_collection: consent.granted ? ['authenticationInfo'] : [] } : {}; },
      async contains(request) { checks.push(request); return consent.granted; }
    },
    storage: { local: { async get() { return {}; }, async set(value) { writes.push(value); } } },
    commands: {},
    runtime: options.firefox ? { getBrowserInfo() {} } : {}
  };
  const providers = { ...globalThis.TLDRProviders, async listModels(config, hooks) {
    modelCalls.push(config);
    if (options.listModels) return options.listModels(config, hooks, consent);
    await hooks.beforeRequest();
    return ['model'];
  } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.js'), 'utf8');
  vm.runInNewContext(source, {
    browser, TLDRProviders: providers, URL, Promise,
    document: { getElementById: getElement, createElement() { return {}; } },
    navigator: { userAgent: 'Chrome' }, confirm: () => true
  });
  return { getElement, requests, writes, checks, modelCalls, consent, browser };
}

async function readyOptions(options = {}) {
  const ui = makeOptions(options);
  await new Promise(resolve => setImmediate(resolve));
  ui.getElement('provider').value = 'ollama';
  ui.getElement('base-url').value = 'http://localhost:11434';
  ui.getElement('model').value = 'model';
  ui.getElement('api-key').value = options.key === undefined ? 'secret' : options.key;
  return ui;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('settings rejects wildcard URLs before requesting any permission', async () => {
  const ui = makeOptions();
  await new Promise(resolve => setImmediate(resolve));
  ui.getElement('provider').value = 'ollama';
  ui.getElement('model').value = 'model';
  for (const url of ['https://*', 'https://*.example.com', 'https://example.com/%2A']) {
    ui.getElement('base-url').value = url;
    ui.getElement('save').click();
    ui.getElement('load-models').click();
    assert.equal(ui.requests.length, 0, url);
    assert.match(ui.getElement('save-status').textContent, /wildcards/i);
    assert.match(ui.getElement('connection-status').textContent, /wildcards/i);
  }
  assert.equal(ui.writes.length, 0);
});

test('settings requests the specific configured host synchronously', async () => {
  const ui = makeOptions();
  await new Promise(resolve => setImmediate(resolve));
  ui.getElement('provider').value = 'ollama';
  ui.getElement('base-url').value = 'http://localhost:11434/api';
  ui.getElement('model').value = 'model';
  ui.getElement('save').click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests)), [{ origins: ['http://localhost/*'] }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.writes[0].config.baseUrl, 'http://localhost:11434/api');
});

test('Firefox requests host and authentication consent synchronously for save and discovery', async () => {
  const ui = await readyOptions({ firefox: true });
  ui.getElement('save').click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests)), [{ origins: ['http://localhost/*'], data_collection: ['authenticationInfo'] }]);
  await flush();
  assert.equal(ui.writes.length, 1);
  ui.getElement('load-models').click();
  assert.equal(ui.requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests[1])), { origins: ['http://localhost/*'], data_collection: ['authenticationInfo'] });
  await flush();
  assert.equal(ui.modelCalls.length, 1);
  assert.ok(ui.checks.length >= 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.checks[0])), { data_collection: ['authenticationInfo'] });
});

test('Firefox denial or revocation prevents saving and model discovery', async () => {
  for (const scenario of [{ request: () => Promise.resolve(false) }, { granted: false }, { supported: false }, { request: () => Promise.reject(new Error('unsupported')) }]) {
    const ui = await readyOptions({ firefox: true, ...scenario });
    ui.getElement('save').click();
    await flush();
    assert.equal(ui.writes.length, 0);
    assert.match(ui.getElement('save-status').textContent, /authentication information permission/i);
    ui.getElement('load-models').click();
    await flush();
    assert.equal(ui.modelCalls.length, 0);
    assert.match(ui.getElement('connection-status').textContent, /authentication information permission/i);
  }
});

test('model discovery rechecks Firefox consent between requests', async () => {
  let fetches = 0;
  const ui = await readyOptions({ firefox: true, async listModels(config, { beforeRequest }, consent) {
    await beforeRequest();
    fetches++;
    consent.granted = false;
    await beforeRequest();
    fetches++;
    return ['model'];
  } });
  ui.getElement('load-models').click();
  await flush();
  assert.equal(fetches, 1);
  assert.match(ui.getElement('connection-status').textContent, /authentication information permission/i);
});

test('keyless Firefox and keyed Chrome request only the host', async () => {
  for (const scenario of [{ firefox: true, key: '' }, { firefox: false, key: 'secret' }]) {
    const ui = await readyOptions(scenario);
    ui.getElement('save').click();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.requests[0])), { origins: ['http://localhost/*'] });
    await flush();
    assert.equal(ui.writes.length, 1);
    ui.getElement('load-models').click();
    await flush();
    assert.equal(ui.modelCalls.length, 1);
    assert.equal(ui.checks.length, 0);
  }
});
