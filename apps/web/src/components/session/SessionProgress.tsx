import type { SessionState } from '../../api/client';

export function SessionProgress({ session }: { session: SessionState }) {
  const { progress, status, plan } = session;

  return (
    <div className="session-progress">
      <div className="progress-header">
        <span className={`status status-${status}`}>{status}</span>
        {progress.currentPhase && <span className="phase">Phase: {progress.currentPhase}</span>}
        {progress.currentTask && <span className="task">Task: {progress.currentTask}</span>}
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="progress-stats">
        {progress.completedTasks} / {progress.totalTasks} tasks ({progress.percent}%)
        {plan && <span> · {plan.tasks.length} planned</span>}
      </div>
    </div>
  );
}
