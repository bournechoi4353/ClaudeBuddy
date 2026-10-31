'use strict';
// Builds the app's raincloud manifest from a freshly generated sheet manifest.
//
//   node scripts/merge-raincloud-manifest.js FRESH.json REACTIONS_FROM.json OUT.json
//
// FRESH.json is the manifest build_v2.py writes (it has the default reaction mapping). The app uses its
// own reaction names, so "reactions" and "ambientReactions" are taken from REACTIONS_FROM.json and
// nothing else in FRESH.json is changed. OUT.json may be the same file as REACTIONS_FROM.json.

const fs = require('node:fs');

const [fresh, from, out] = process.argv.slice(2);
if (!fresh || !from || !out) {
  console.error('usage: node scripts/merge-raincloud-manifest.js FRESH.json REACTIONS_FROM.json OUT.json');
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(fresh, 'utf8'));
const source = JSON.parse(fs.readFileSync(from, 'utf8'));
for (const field of ['reactions', 'ambientReactions']) {
  if (!source[field]) { console.error(`${from} has no "${field}"`); process.exit(1); }
  base[field] = source[field];
}
fs.writeFileSync(out, JSON.stringify(base, null, 2) + '\n');
console.log(`wrote ${out} (${Object.keys(base.poses).length} poses, ${Object.keys(base.reactions).length} reactions)`);
