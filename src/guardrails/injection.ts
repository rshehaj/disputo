/**
 * Prompt-injection screening for untrusted customer text.
 *
 * This is one layer of defense, not the only one:
 *  1. screen + sanitize the text (this file)
 *  2. pass it to the LLM only inside <customer_message> delimiters marked as data
 *  3. tools are scoped to the authenticated customer (the LLM cannot widen access)
 *  4. the deterministic policy engine has the final say over any money movement
 * A flagged message can still be processed, but it can never be auto-approved.
 */

export interface InjectionScreen {
  flagged: boolean;
  score: number;
  signals: string[];
  sanitized: string;
}

interface Pattern {
  id: string;
  re: RegExp;
  weight: number;
}

const PATTERNS: Pattern[] = [
  {
    id: 'ignore_instructions',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(instructions?|rules?|polic(?:y|ies)|prompts?|guidelines|guardrails)\b/i,
    weight: 3,
  },
  { id: 'role_hijack', re: /\b(you are now|act as (?:an?|the)|pretend (?:to be|you are)|from now on,? you)\b/i, weight: 2 },
  { id: 'mode_switch', re: /\b(admin|developer|debug|god|jailbreak|DAN)\s+mode\b/i, weight: 2 },
  { id: 'system_prompt_probe', re: /\b(system prompt|developer message|hidden instructions|your instructions)\b/i, weight: 3 },
  { id: 'fake_role_tag', re: /(^|\n)\s*\[?(system|assistant|developer|tool)\]?\s*:/i, weight: 3 },
  { id: 'delimiter_escape', re: /<\/?\s*(customer_message|request_context|findings|system|instructions?)\s*>/i, weight: 3 },
  { id: 'jailbreak_terms', re: /\b(jailbreak|do anything now|no restrictions)\b/i, weight: 3 },
  {
    id: 'authority_claim',
    re: /\b(i am|i'm) (?:an?|the|your) (admin|administrator|manager|developer|supervisor|ceo)\b|\bauthori[sz]ed by (?:the )?(management|admin|ceo)\b/i,
    weight: 2,
  },
  { id: 'tool_manipulation', re: /\b(call|invoke|run|execute|use)\b[^.\n]{0,30}\b(tool|function|api)\b/i, weight: 2 },
  { id: 'no_escalation_demand', re: /\b(do not|don't|never)\s+(escalate|involve a human|send (?:it )?to review)\b/i, weight: 2 },
  { id: 'encoded_payload', re: /[A-Za-z0-9+/]{120,}={0,2}/, weight: 2 },
];

export const INJECTION_THRESHOLD = 3;

// Zero-width and bidi control characters often used to hide instructions.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;
// ASCII control characters except \t \n \r
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DELIMITER_TAGS = /<\/?\s*(customer_message|request_context|findings|reply_context)\s*>/gi;

export function sanitizeUntrustedText(text: string, maxLength = 4000): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(DELIMITER_TAGS, '[removed-tag]')
    .slice(0, maxLength)
    .trim();
}

export function screenForInjection(text: string): InjectionScreen {
  const normalized = text.normalize('NFKC').replace(INVISIBLE, '');
  const signals: string[] = [];
  let score = 0;
  for (const p of PATTERNS) {
    if (p.re.test(normalized)) {
      signals.push(p.id);
      score += p.weight;
    }
  }
  if (normalized.length !== text.length) {
    signals.push('invisible_characters');
    score += 1;
  }
  return {
    flagged: score >= INJECTION_THRESHOLD,
    score,
    signals,
    sanitized: sanitizeUntrustedText(text),
  };
}
