// AI-driven, live per-step exploration — the one flow in this codebase where the NEXT
// ACTION itself is decided by a model looking at the actual current page, not a pre-written
// script. Every other flow (including journey.ts's per-site-type journeys) runs a fixed,
// hand-authored sequence of steps; this one perceives → reasons → acts → perceives again,
// genuinely adapting to whatever the site shows it, the way a human exploratory tester does.
//
// Deliberately bounded and additive, matching every other AI-gated flow in this codebase:
//   - Skips outright if no LLM API key is configured (see llm-client.ts) — never load-bearing.
//   - Only runs at standard/deep depth (this is multiple AI calls, not visual-review's one).
//   - Hard step cap (MAX_STEPS) bounds cost and wall-clock regardless of what the model wants.
//   - Every risky-looking action still goes through the SAME gateIfSensitive() gate as every
//     other flow — the model can choose to click "Delete" or "Pay Now" (that's a legitimate
//     thing to explore), but it can never bypass the human-confirmation safety rail to do it.
//   - High-risk and sensitive input fields (classifyInputRisk) are never even offered as
//     options — the model cannot fill them because they never appear in its choice list, not
//     because it was asked nicely not to.
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { ExecutorContext, FlowTask, Severity } from '@qa/shared';
import {
  describeElement,
  gateIfSensitive,
  waitForRealContent,
  findVisibleErrorText,
  dismissBlockingOverlay,
} from './helpers.js';
import { classifyInputRisk } from './forms.js';
import { getVisitedStates } from './page-visit-tracker.js';
import { callLLM, hasAnyLLMKey } from '@qa/shared';

const STEP_TIMEOUT_MS = 10000;
const MAX_STEPS = 4;
// UiExecutor races every flow against a 90s task timeout. The original "5 steps * up to 12s
// Gemini call stays comfortably under that" estimate turned out wrong in practice — real
// per-step cost on a complex real-world page (enumerating dozens of candidates, overlay
// checks, page settle waits) plus the Gemini call routinely pushed the WHOLE task over 90s,
// which meant the outer timeout killed it mid-action and reported a generic "Task error" —
// exactly the kind of noise this flow is supposed to never produce. Rather than continuing to
// guess at a per-step budget that covers every real page, this tracks actual elapsed wall
// time and stops itself with whatever it's found so far, well inside the outer deadline,
// instead of leaving the outer timeout as the only backstop.
const OVERALL_DEADLINE_MS = 65000;
const MAX_ELEMENTS = 25;
const ELIGIBLE_DEPTHS = new Set(['standard', 'deep']);

const CANDIDATE_SELECTOR =
  'button:not([tabindex="-1"]), [role="button"]:not([tabindex="-1"]), input[type="button"], input[type="submit"], ' +
  '[role="menuitem"]:not([tabindex="-1"]), [role="tab"]:not([tabindex="-1"]), ' +
  'a[href]:not([href^="mailto:"]):not([href^="tel:"]):not([tabindex="-1"]), [onclick]:not([tabindex="-1"]), [tabindex="0"], ' +
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), select, textarea';

type ElementKind = 'click' | 'fill' | 'select';

interface EnumeratedElement {
  index: number;
  locator: Locator;
  kind: ElementKind;
  description: string;
}

interface StepHistoryEntry {
  step: number;
  action: string;
  target: string;
  reasoning: string;
  outcome: string;
}

interface ModelStep {
  reasoning?: string;
  action?: 'click' | 'fill' | 'select' | 'stop';
  elementIndex?: number;
  value?: string;
  done?: boolean;
  findingIfBug?: {
    title?: string;
    severity?: string;
    expected?: string;
    actual?: string;
  } | null;
}

async function enumerateElements(page: Page): Promise<EnumeratedElement[]> {
  const candidates = page.locator(CANDIDATE_SELECTOR);
  const count = await candidates.count().catch(() => 0);
  const out: EnumeratedElement[] = [];

  for (let i = 0; i < count && out.length < MAX_ELEMENTS; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;

    const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => '');
    const inputType =
      tag === 'input' ? ((await el.getAttribute('type').catch(() => '')) || 'text').toLowerCase() : '';

    if (tag === 'select') {
      const desc = await describeElement(el, out.length);
      out.push({ index: out.length, locator: el, kind: 'select', description: `[dropdown] ${desc}` });
      continue;
    }

    const isTextualInput = tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio'].includes(inputType));
    if (isTextualInput) {
      const name = (await el.getAttribute('name').catch(() => '')) || '';
      const placeholder = (await el.getAttribute('placeholder').catch(() => '')) || '';
      const desc = await describeElement(el, out.length);
      const risk = classifyInputRisk(name, placeholder, desc, inputType);
      // High-risk/sensitive fields are never offered as an option at all — the model
      // cannot choose to fill something it never sees in its own candidate list. This is a
      // structural guarantee, not a prompt instruction the model could ignore.
      if (risk !== 'safe') continue;
      out.push({
        index: out.length,
        locator: el,
        kind: 'fill',
        description: `[input:${inputType || 'text'}] ${desc || placeholder || name || 'unlabeled field'}`,
      });
      continue;
    }

    // Everything else (buttons, links, checkboxes/radios, menu items, tabs) is a click target.
    const desc = await describeElement(el, out.length);
    out.push({ index: out.length, locator: el, kind: 'click', description: desc });
  }

  return out;
}

async function buildPrompt(
  page: Page,
  elements: EnumeratedElement[],
  history: StepHistoryEntry[],
  ctx: ExecutorContext,
): Promise<string> {
  const elementLines = elements
    .map((e) => `${e.index}. [${e.kind}] ${e.description}`.slice(0, 160))
    .join('\n');

  const historyLines =
    history.length > 0
      ? history
          .map((h) => `Step ${h.step}: ${h.action} "${h.target}" — reasoning: ${h.reasoning} — outcome: ${h.outcome}`)
          .join('\n')
      : '(none yet — this is the first step)';

  const siteContext = ctx.classification
    ? `Site classified as: ${ctx.classification.siteType} (${Math.round(ctx.classification.confidence * 100)}% confidence). Known journeys worth testing: ${ctx.classification.inferredJourneys.slice(0, 4).join('; ') || 'none inferred'}.`
    : 'Site not yet classified.';

  // Session-wide state memory (not just this task's own 4-step history below) — other tasks
  // (the BFS navigation flow, earlier agentic-explore runs) may have already covered a state
  // this task is about to re-explore. Capped so this doesn't dominate the prompt on a
  // long-running session; a large first-seen sample is more useful than an exhaustive one.
  const priorStates = getVisitedStates(ctx.sessionId);
  const priorStatesLine =
    priorStates.length > 0
      ? `Already explored elsewhere this session (${priorStates.length} distinct state(s), sample): ${priorStates.slice(0, 15).join(', ')}`
      : 'No other states recorded as explored yet this session.';

  return `You are an exploratory QA tester operating a real web browser one step at a time. You can see the current page's interactive elements below. Decide the SINGLE most useful next action to uncover a real bug or explore genuinely untested behavior — do not repeat an action already listed in history unless testing something new about it (e.g. a second click to check idempotency).

${siteContext}

CURRENT PAGE: ${page.url()}
TITLE: ${(await page.title().catch(() => '')) || '(none)'}

INTERACTIVE ELEMENTS ON THIS PAGE (pick by index; "fill" elements are pre-filtered to only safe, non-PII fields):
${elementLines || '(none found — consider stopping)'}

ACTIONS TAKEN SO FAR THIS TASK:
${historyLines}

${priorStatesLine}
Prefer navigating to a state that hasn't been explored yet over one already covered above, when both are plausible next steps.

Respond with ONLY a JSON object (no markdown fences, no commentary), shaped exactly as:
{
  "reasoning": "one sentence: why this specific action, right now",
  "action": "click" | "fill" | "select" | "stop",
  "elementIndex": <number, required unless action is "stop">,
  "value": "<only for fill/select — a short, safe, realistic value>",
  "findingIfBug": null OR {"title": "...", "severity": "critical"|"high"|"medium"|"low", "expected": "...", "actual": "..."},
  "done": true if you believe nothing more useful remains to explore on this page/flow, else false
}

Only set "findingIfBug" when you can point to something concretely wrong that already happened (an error, a crash, a broken state) — not a hypothesis about what MIGHT go wrong. Choose "stop" once you've covered the meaningfully different actions available, rather than repeating minor variations.`;
}

function extractJsonObject(text: string): ModelStep | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? (parsed as ModelStep) : null;
  } catch {
    return null;
  }
}

function normalizeSeverity(raw: string | undefined): Severity {
  const s = (raw ?? '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') return s;
  return 'low';
}

async function askLLMForNextStep(prompt: string): Promise<ModelStep | null> {
  try {
    const text = await callLLM(prompt, STEP_TIMEOUT_MS);
    if (!text) return null;
    return extractJsonObject(text);
  } catch {
    return null;
  }
}

async function shot(page: Page, ctx: ExecutorContext, name: string): Promise<string | undefined> {
  const p = join(ctx.sessionsDir, ctx.sessionId, 'screenshots', `agentic-explore-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch {
    return undefined;
  }
}

export async function runAgenticExplore(page: Page, ctx: ExecutorContext, _task: FlowTask): Promise<void> {
  if (!hasAnyLLMKey()) {
    ctx.onLog('[AgenticExplore] No LLM API key configured — skipping AI-driven exploration loop');
    return;
  }
  if (!ELIGIBLE_DEPTHS.has(ctx.config.depth)) {
    ctx.onLog(`[AgenticExplore] Skipping at "${ctx.config.depth}" depth — runs at standard/deep only`);
    return;
  }
  if (ctx.envDegraded) {
    // The outer task timeout is only 30s once the environment is flagged degraded — a single
    // slow Gemini call could already consume most of that, leaving no real room for this loop
    // to do anything useful. Skip cleanly rather than all but guarantee an outer-timeout kill.
    ctx.onLog('[AgenticExplore] Skipping — environment flagged degraded, not enough time budget for a meaningful reasoning loop');
    return;
  }

  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  const history: StepHistoryEntry[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (Date.now() >= deadline) {
      ctx.onLog(`[AgenticExplore] Stopping after ${step - 1} action(s) — time budget used, wrapping up cleanly instead of running into the outer task timeout`);
      break;
    }
    await waitForRealContent(page).catch(() => {});
    // A modal left open by the PREVIOUS step's action (one its own click handler didn't
    // account for) would otherwise both mislead the model's view of the page and make its
    // next chosen action time out and get reported as a false "action failed" outcome — the
    // same cascading-false-positive pattern action-inventory.ts hits, for the same reason.
    await dismissBlockingOverlay(page).catch(() => {});
    const elements = await enumerateElements(page);

    if (elements.length === 0) {
      ctx.onLog('[AgenticExplore] No interactive elements found on this page — stopping');
      break;
    }

    const prompt = await buildPrompt(page, elements, history, ctx);
    const decision = await askLLMForNextStep(prompt);

    if (!decision || !decision.action) {
      ctx.onLog(`[AgenticExplore] Step ${step}: no usable response from Gemini — stopping loop`);
      break;
    }

    ctx.onLog(`[AgenticExplore] Step ${step} reasoning: ${decision.reasoning ?? '(none given)'}`);

    if (decision.action === 'stop' || decision.done) {
      ctx.onLog(`[AgenticExplore] Model decided to stop after ${step - 1} action(s)`);
      break;
    }

    const target = elements.find((e) => e.index === decision.elementIndex);
    if (!target) {
      ctx.onLog(`[AgenticExplore] Step ${step}: model picked an invalid element index — stopping loop`);
      break;
    }

    const urlBefore = page.url();
    let outcome = 'no visible change';

    try {
      if (target.kind === 'click') {
        const proceed = await gateIfSensitive(page, ctx, target.description);
        if (!proceed) {
          history.push({ step, action: 'click', target: target.description, reasoning: decision.reasoning ?? '', outcome: 'skipped — sensitive action, no confirmation given' });
          continue;
        }
        await target.locator.click({ timeout: 5000 });
      } else if (target.kind === 'fill') {
        await target.locator.fill((decision.value ?? 'Test value').slice(0, 100), { timeout: 5000 });
      } else if (target.kind === 'select') {
        await target.locator.selectOption({ label: decision.value ?? '' }).catch(() =>
          target.locator.selectOption({ index: 1 }).catch(() => {}),
        );
      }

      await waitForRealContent(page).catch(() => {});
      const urlAfter = page.url();
      const errorText = await findVisibleErrorText(page).catch(() => null);

      if (urlAfter !== urlBefore) outcome = `navigated to ${urlAfter}`;
      else if (errorText) outcome = `visible error/validation message appeared: "${errorText.slice(0, 120)}"`;
    } catch (err) {
      outcome = `action failed: ${(err as Error).message.slice(0, 150)}`;
    }

    history.push({
      step,
      action: target.kind,
      target: target.description,
      reasoning: decision.reasoning ?? '',
      outcome,
    });

    if (decision.findingIfBug?.title) {
      const evidence = await shot(page, ctx, `step-${step}`);
      ctx.onFinding({
        severity: normalizeSeverity(decision.findingIfBug.severity),
        area: 'AI-Explore',
        title: decision.findingIfBug.title.slice(0, 120),
        steps: [`Navigate to ${urlBefore}`, `${target.kind} "${target.description}"`],
        expected: decision.findingIfBug.expected || 'No defect',
        actual: decision.findingIfBug.actual || outcome,
        evidence: evidence ? [evidence] : [],
        reproRate: '1/1',
        automationCandidate: false,
        pageUrl: page.url(),
        confidence: 'heuristic',
        confidenceReason:
          'Raised by the live AI exploration loop reasoning about one observed page state, not cross-validated against a second signal — verify before treating as confirmed.',
      });
    }
  }

  ctx.onLog(`[AgenticExplore] Completed after ${history.length} action(s)`);
}
