import type { Finding, Severity } from '@qa/shared';
import { computeHealthScore } from '@qa/shared';

export interface FindingsQaContext {
  findings: Finding[];
  targetUrl: string;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const SEVERITY_WORDS: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low',
  info: 'info',
  informational: 'info',
};

const STOP_WORDS = new Set([
  'what', 'show', 'tell', 'about', 'issue', 'issues', 'finding', 'findings', 'there', 'were',
  'found', 'this', 'session', 'have', 'that', 'with', 'were', 'from', 'does', 'any', 'the', 'are',
]);

function formatFinding(f: Finding, i?: number): string {
  const prefix = i !== undefined ? `${i + 1}. ` : '';
  return `${prefix}[${f.severity.toUpperCase()}] ${f.title} — ${f.actual}`;
}

/**
 * Deterministic, pattern-matched Q&A over a completed session's findings — no LLM call,
 * consistent with the rest of this codebase being fully local with zero external API
 * dependency.
 */
export function answerFindingsQuestion(question: string, ctx: FindingsQaContext): string {
  const q = question.toLowerCase().trim();
  const { findings } = ctx;

  if (findings.length === 0) {
    return 'No findings were recorded for this session — clean run!';
  }

  if (/\b(health|overall|how (healthy|good|bad)|score|grade)\b/.test(q)) {
    const h = computeHealthScore(findings);
    return `Health score: **${h.grade} (${h.score}/100)**. ${h.summary}`;
  }

  if (/\bhow many\b/.test(q)) {
    return `${findings.length} finding(s) total for ${ctx.targetUrl}.`;
  }

  if (/\b(riskiest|worst|most severe|highest severity|biggest (issue|risk|problem))\b/.test(q)) {
    const sorted = [...findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    const top = sorted[0];
    return (
      `The riskiest issue is:\n\n${formatFinding(top)}\n\n` +
      `Expected: ${top.expected}\n` +
      (top.steps.length ? `Steps: ${top.steps.join(' → ')}` : '')
    );
  }

  for (const [word, severity] of Object.entries(SEVERITY_WORDS)) {
    if (q.includes(word)) {
      const matches = findings.filter((f) => f.severity === severity);
      if (matches.length === 0) return `No ${severity}-severity findings — good news.`;
      return `${matches.length} ${severity}-severity finding(s):\n\n${matches
        .map((f, i) => formatFinding(f, i))
        .join('\n')}`;
    }
  }

  if (/\b(list|show all|summarize|summary|everything)\b/.test(q)) {
    return findings.map((f, i) => formatFinding(f, i)).join('\n');
  }

  const keywords = q
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  if (keywords.length > 0) {
    const matches = findings.filter((f) => {
      const haystack = `${f.title} ${f.area} ${f.actual} ${f.expected}`.toLowerCase();
      return keywords.some((k) => haystack.includes(k));
    });
    if (matches.length > 0) {
      return `${matches.length} finding(s) matching "${keywords.join(', ')}":\n\n${matches
        .map((f, i) => formatFinding(f, i))
        .join('\n')}`;
    }
  }

  return (
    'I couldn\'t find findings matching that specifically. Try asking about severity ' +
    '(critical/high/medium/low), an area (mobile, accessibility, security, forms), ' +
    '"summarize", "riskiest issue", or "health score".'
  );
}
