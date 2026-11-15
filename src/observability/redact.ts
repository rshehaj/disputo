const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const MAX_STRING = 1500;

export function maskEmail(text: string): string {
  return text.replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

/** Deep-copies a value for logging: masks e-mail addresses and truncates long strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') {
    const masked = maskEmail(value);
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[+${masked.length - MAX_STRING} chars]` : masked;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, depth + 1)]));
  }
  return value;
}
