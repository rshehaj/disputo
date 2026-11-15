import { readFileSync } from 'node:fs';

export interface PolicySection {
  id: string;
  title: string;
  text: string;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'is', 'are', 'be', 'in', 'on', 'with',
  'it', 'my', 'i', 'was', 'that', 'this', 'by', 'as', 'at', 'not', 'if', 'no',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function parsePolicy(markdown: string): PolicySection[] {
  const sections: PolicySection[] = [];
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const [heading = '', ...body] = part.split('\n');
    const match = /^(RP-\d+)\s+(.*)$/.exec(heading.trim());
    if (!match) continue;
    sections.push({ id: match[1]!, title: match[2]!.trim(), text: body.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return sections;
}

/**
 * Keyword search over the policy document (BM25-lite: term overlap, title boost).
 * Deliberately simple and deterministic; swap for embeddings/vector search in production.
 */
export class PolicyIndex {
  constructor(private readonly sections: PolicySection[]) {
    if (sections.length === 0) throw new Error('Policy document has no RP-n sections');
  }

  static fromFile(path = 'policies/refund-policy.md'): PolicyIndex {
    return new PolicyIndex(parsePolicy(readFileSync(path, 'utf8')));
  }

  get ids(): string[] {
    return this.sections.map((s) => s.id);
  }

  search(query: string, limit = 3): PolicySection[] {
    const q = new Set(tokenize(query.replace(/_/g, ' ')));
    if (q.size === 0) return [];
    return this.sections
      .map((s) => {
        const title = tokenize(s.title);
        const body = tokenize(s.text);
        let score = 0;
        for (const t of title) if (q.has(t)) score += 3;
        for (const t of body) if (q.has(t)) score += 1;
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
      .slice(0, limit)
      .map((x) => x.s);
  }
}
