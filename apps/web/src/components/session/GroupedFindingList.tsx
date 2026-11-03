import type { Finding } from '@qa/shared';
import { collapseDuplicateNotes, findingSectionLabel, sortFindingsForDisplay } from '@qa/shared';
import { FindingCard } from './FindingCard';

/**
 * The one way findings are listed in the UI (live page and report page), in the same order as
 * the downloadable report: UI & interaction → API → JavaScript errors → resilience/performance →
 * security, then info notes, then agent execution issues — each block under its own heading.
 */
export function GroupedFindingList({ findings, sessionId }: { findings: Finding[]; sessionId: string }) {
  const sorted = sortFindingsForDisplay(collapseDuplicateNotes(findings));
  return (
    <div className="findings-list">
      {sorted.map((f, i) => {
        const category = findingSectionLabel(f);
        const startsGroup = i === 0 || findingSectionLabel(sorted[i - 1]) !== category;
        return (
          <div key={f.id}>
            {startsGroup && <h3 className="findings-category">{category}</h3>}
            <FindingCard finding={f} sessionId={sessionId} />
          </div>
        );
      })}
    </div>
  );
}

/** Number of findings that will actually be listed (after repeated notes are collapsed). */
export function listedFindingCount(findings: Finding[]): number {
  return collapseDuplicateNotes(findings).length;
}
