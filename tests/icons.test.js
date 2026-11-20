'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('Firefox manifest requires consent-capable desktop Firefox', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.equal(manifest.browser_specific_settings.gecko_android, undefined);
});

test('browser manifests use supplied PNGs for extension and toolbar icons', () => {
  for (const file of ['manifest.json', 'manifest.chrome.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const iconSets = [manifest.icons, manifest.action.default_icon];
    if (manifest.sidebar_action) iconSets.push(manifest.sidebar_action.default_icon);
    for (const icons of iconSets) {
      for (const size of [16, 32, 48, 64, 128]) {
        assert.equal(icons[size], `src/icon-${size}.png`, `${file}: ${size}px`);
        const png = fs.readFileSync(path.join(root, icons[size]));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), size, `${file}: icon width`);
        assert.equal(png.readUInt32BE(20), size, `${file}: icon height`);
      }
    }
  }
});
