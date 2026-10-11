'use strict';
// Native regression: run after compiling desktop/bin/speech-export on macOS.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const bin = path.resolve(__dirname, '../desktop/bin/speech-export');
const rows = JSON.parse(cp.execFileSync(bin, ['--rate-map'], {encoding: 'utf8'}));
const expected = [[0.5,0.25],[0.8,0.4],[1,0.5],[1.5,0.5+0.5/6],[2,0.5+0.5/3],[4,1]];
assert.equal(rows.length, expected.length);
for (let i=0; i<rows.length; i++) {
  assert(Math.abs(rows[i].web-expected[i][0])<1e-6);
  assert(Math.abs(rows[i].native-expected[i][1])<1e-6);
}
console.log('Native rate mapping passed: 0.5 / 0.8 / 1 / 1.5 / 2 / 4');
