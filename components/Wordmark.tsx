/** The Depeche wordmark. `glitch` adds the title-card effect; everywhere else it stays clean. */
export function Wordmark({ glitch = false, className = "" }: { glitch?: boolean; className?: string }) {
  if (!glitch) return <span className={`wordmark ${className}`}>Depeche</span>;

  const layer = (
    <span className="layer" aria-hidden="true">
      <span className="ch r">Depeche</span>
      <span className="ch c">Depeche</span>
      <span className="ch w">Depeche</span>
    </span>
  );
  return (
    <span className={`wordmark glitch ${className}`} role="img" aria-label="Depeche">
      <span className="base">{layer}</span>
      <span className="slice s1">{layer}</span>
      <span className="slice s2">{layer}</span>
    </span>
  );
}
