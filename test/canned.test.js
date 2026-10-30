const test = require('node:test');
const assert = require('node:assert');
const canned = require('../vendor/pet-brain/canned.json');
const { REACTIONS } = require('../vendor/pet-brain/rules.js');
const { lineProblems } = require('../vendor/pet-brain/lineCheck.js');
const { personaProblems } = require('../vendor/pet-brain/personaCheck.js');

test('the bank has every reaction and no extras, with at least 5 lines each', () => {
  assert.deepStrictEqual(Object.keys(canned).sort(), [...REACTIONS].sort());
  for (const reaction of REACTIONS) {
    assert.ok(canned[reaction].length >= 5, `${reaction} needs at least 5 lines (has ${canned[reaction].length})`);
  }
});

test('every line passes the length, banned-word and persona checks', () => {
  for (const reaction of REACTIONS) {
    for (const line of canned[reaction]) {
      assert.deepStrictEqual(lineProblems(line), [], `${reaction}: "${line}"`);
      assert.deepStrictEqual(personaProblems(line), [], `${reaction}: "${line}"`);
    }
  }
});

test('lines are unique within a reaction and have no exclamation marks or em dashes', () => {
  for (const reaction of REACTIONS) {
    const lines = canned[reaction];
    assert.strictEqual(new Set(lines.map((l) => l.toLowerCase())).size, lines.length, `${reaction} has a duplicate`);
    for (const line of lines) {
      assert.ok(!line.includes('!'), `${reaction}: "${line}" has an exclamation mark`);
      assert.ok(!line.includes('—'), `${reaction}: "${line}" has an em dash`);
    }
  }
});
