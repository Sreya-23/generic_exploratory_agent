/**
 * Known demo / environment quirks — quarantine so they don't look like production HIGHs.
 */
import type { Finding } from '@qa/shared';

type FindingDraft = Omit<Finding, 'id' | 'sessionId' | 'createdAt'>;

interface QuirkRule {
  id: string;
  test: (origin: string, finding: FindingDraft) => boolean;
  reason: string;
}

const RULES: QuirkRule[] = [
  {
    id: 'saucedemo-empty-cart-checkout',
    test: (origin, f) =>
      /saucedemo\.com/i.test(origin) &&
      (/empty cart.*(checkout|complete)|empty-cart|Checkout enabled on empty cart/i.test(
        `${f.title} ${f.actual}`,
      ) ||
        (/0 line items/i.test(f.actual) && /Checkout still enabled/i.test(f.actual))),
    reason:
      'Sauce Demo keeps Checkout enabled / reachable with an empty cart — known demo behavior, not a production-style defect',
  },
  {
    id: 'saucedemo-back-blank-history',
    test: (_origin, f) =>
      /about:blank/i.test(f.actual) && /Broken page after Back/i.test(f.title),
    reason: 'Browser history was empty (about:blank) — harness noise, not an application crash',
  },
];

/** Downgrade + tag known quirks. Returns the (possibly modified) finding draft. */
export function quarantineKnownQuirk(
  targetUrl: string,
  finding: FindingDraft,
): FindingDraft {
  let origin = '';
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    origin = targetUrl;
  }

  for (const rule of RULES) {
    if (!rule.test(origin, finding)) continue;
    return {
      ...finding,
      severity: 'info',
      quarantineReason: rule.reason,
      tags: [...new Set([...(finding.tags ?? []), 'known-demo-quirk', rule.id])],
      title: `[quirk] ${finding.title}`,
      actual: `${finding.actual} — QUARANTINED: ${rule.reason}`,
    };
  }
  return finding;
}
