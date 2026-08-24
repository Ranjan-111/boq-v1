const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

test('every frontend module is served by the allowlist', () => {
  const jsDir = join(__dirname, '..', 'public', 'js');
  const serverSrc = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const m = serverSrc.match(/FRONTEND_MODULES = new Set(.([^)]+).)/);
  assert.ok(m, 'FRONTEND_MODULES found');
  const allowed = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  const onDisk = readdirSync(jsDir).filter(n => n.endsWith('.mjs')).map(n => '/js/' + n);
  for (const path of onDisk) {
    assert.ok(allowed.has(path), path + ' not in FRONTEND_MODULES');
  }
});