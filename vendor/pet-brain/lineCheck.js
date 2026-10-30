'use strict';
// Validator for pet lines. Same checks as line_problems() in the training repo (scripts/common.py).
const { max_line_chars: MAX_LINE_CHARS, banned_substrings: BANNED } = require('./banned.json');

/** Return a list of problems. An empty list means the line is acceptable. */
function lineProblems(line) {
  if (typeof line !== 'string' || line.trim() === '') return ['empty line'];
  const problems = [];
  if (/[\r\n]/.test(line)) problems.push('multi-line');
  if (line.length > MAX_LINE_CHARS) problems.push(`${line.length} chars`);
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(line)) problems.push('non-ASCII');
  const low = line.toLowerCase();
  for (const b of BANNED) if (low.includes(b)) problems.push(`banned '${b}'`);
  return problems;
}

/** Clean raw model text: trim, drop wrapping quotes and special tokens, collapse spaces. Does not fix real problems. */
function sanitizeLine(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/<\|[^|>]*\|>/g, '').trim();
  t = t.replace(/[ \t]+/g, ' '); // keep newlines: a multi-line answer must fail validation, not be flattened
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
  return t;
}

module.exports = { lineProblems, sanitizeLine, MAX_LINE_CHARS };
