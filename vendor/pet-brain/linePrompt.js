'use strict';
// Builds the exact text the line model was trained on (ChatML with an empty think block).
// The user text must match line_user_text() in the training repo's scripts/common.py.
const { normalizeSignals, dayPart } = require('./rules.js');
const { system: SYSTEM_PROMPT, user_format: USER_FORMAT = 1 } = require('./prompt.json');

/** format 1: hour only (first model). format 2: hour plus a daypart word (current model). */
function userText(signals, reaction, format = USER_FORMAT) {
  const s = normalizeSignals(signals);
  const hour = format >= 2 ? `hour=${s.hour} daypart=${dayPart(s.hour)}` : `hour=${s.hour}`;
  return `${reaction} app=${s.app_category} idle=${s.idle_s} typing=${s.typing} ${hour} music=${s.music} event=${s.event}`;
}

/** Fixed first part of every prompt (the system turn). Same for every request, so it can be cached. */
function prefixText() {
  return `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n`;
}

/** Full prompt, ending where the model starts writing the line. */
function buildPrompt(signals, reaction, format = USER_FORMAT) {
  return `${prefixText()}<|im_start|>user\n${userText(signals, reaction, format)}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

module.exports = { buildPrompt, prefixText, userText, SYSTEM_PROMPT, USER_FORMAT };
