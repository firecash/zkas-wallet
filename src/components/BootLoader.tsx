// The animated loading window shown while a route chunk (or the wallet itself)
// is still arriving. It deliberately mirrors the inline boot splash in
// `index.html` — the same drawing shield, teal aurora, wordmark and promise — so
// the hand-off from the browser's first paint → this React screen → the app is
// one continuous animation rather than three different loading states.

export function BootLoader({ label = "Opening…" }: { label?: string }) {
  return (
    <div className="bootload" role="status" aria-live="polite" aria-label={label}>
      <div className="bootload-aurora" aria-hidden="true" />
      <div className="bootload-stage">
        <div className="connect-shield bootload-shield" aria-hidden="true">
          <svg viewBox="0 0 48 56" width="64" height="74">
            <path
              className="connect-shield-path"
              d="M24 2 L44 10 V26 C44 40 35 50 24 54 C13 50 4 40 4 26 V10 Z"
              fill="none"
              stroke="var(--ember)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <path
              className="connect-shield-check"
              d="M16 27 L22 34 L33 20"
              fill="none"
              stroke="var(--ember)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="bootload-mark">
          <span>Z</span>Kas
        </div>
        <div className="bootload-tag">{label}</div>
        <div className="bootload-bar" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
