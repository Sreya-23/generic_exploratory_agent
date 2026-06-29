export function LiveLog({ logs }: { logs: string[] }) {
  return (
    <div className="live-log">
      {logs.length === 0 ? (
        <p className="empty-state">Waiting for activity...</p>
      ) : (
        logs.map((log, i) => (
          <div key={i} className="log-line">
            {log}
          </div>
        ))
      )}
    </div>
  );
}
