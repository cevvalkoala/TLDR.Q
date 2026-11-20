'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('real model discovery stops pagination when Firefox consent is revoked', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false,
      classList: { toggle() {} },
      addEventListener(name, handler) { this[name] = handler; },
      replaceChildren() {}, append() {}
    });
    return elements.get(id);
  }
  let granted = true;
  const requests = [];
  const fetches = [];
  const browser = {
    runtime: { getBrowserInfo() {} },
    permissions: {
      request(details) { requests.push(JSON.parse(JSON.stringify(details))); return Promise.resolve(true); },
      async getAll() { return { data_collection: granted ? ['authenticationInfo'] : [] }; },
      async contains() { return granted; }
    },
    storage: { local: { async get() { return {}; }, async set() {} } },
    commands: {}
  };
  const context = vm.createContext({
    browser, URL, Promise, TextEncoder, AbortController,
    document: { getElementById: element, createElement() { return {}; } },
    navigator: { userAgent: 'Firefox/140' }, confirm: () => true,
    async fetch(url) {
      fetches.push(url);
      granted = false;
      return { ok: true, async json() { return { data: [{ id: 'first' }], has_more: true, last_id: 'first' }; } };
    }
  });
  for (const file of ['providers.js', 'options.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context, { filename: file });
  }
  await new Promise(resolve => setImmediate(resolve));
  element('provider').value = 'anthropic';
  element('base-url').value = 'https://api.anthropic.com/v1';
  element('api-key').value = 'secret';
  element('load-models').click();
  assert.deepEqual(requests, [{ origins: ['https://api.anthropic.com/*'], data_collection: ['authenticationInfo'] }]);
  for (let i = 0; i < 20 && !element('connection-status').textContent.includes('permission is required'); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(fetches.length, 1);
  assert.match(element('connection-status').textContent, /authentication information permission/i);
});
