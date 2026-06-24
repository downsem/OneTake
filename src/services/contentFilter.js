const BLOCKED_PATTERNS = [
  /kill\s+yourself/i,
  /go\s+die/i,
  /terrorist\s+threat/i,
  /sexual\s+content/i,
  /explicit\s+sexual/i,
  /child\s+sexual/i,
  /hate\s+speech/i,
  /racial\s+slur/i,
  /abusive\s+threat/i,
];

export function checkTextAllowed(text) {
  const value = String(text || '').trim();
  if (!value) return { allowed: true };

  const matched = BLOCKED_PATTERNS.find((pattern) => pattern.test(value));
  if (matched) {
    return {
      allowed: false,
      reason: 'This content may violate OneTake community guidelines.',
    };
  }

  return { allowed: true };
}

export function assertTextAllowed(text, fieldName = 'This field') {
  const result = checkTextAllowed(text);
  if (!result.allowed) {
    throw new Error(`${fieldName} may violate OneTake community guidelines. Please revise it before continuing.`);
  }
}
