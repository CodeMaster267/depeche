"use client";

import { useEffect, useId, useState } from "react";

/**
 * Draws a Mermaid diagram from a reply. Mermaid is large, so it loads only when a reply contains a
 * diagram. It runs in "strict" mode, which strips scripts and click handlers from the drawing.
 * If the diagram can't be drawn, its source is shown instead.
 */
export function Mermaid({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
          themeVariables: {
            darkMode: dark,
            background: "transparent",
            primaryColor: dark ? "#000000" : "#ffffff",
            primaryTextColor: dark ? "#f2f2f2" : "#0a0a0a",
            primaryBorderColor: dark ? "#f2f2f2" : "#0a0a0a",
            lineColor: dark ? "#f2f2f2" : "#0a0a0a",
            secondaryColor: dark ? "#0e0e0e" : "#f5f5f5",
            tertiaryColor: dark ? "#0e0e0e" : "#f5f5f5",
            textColor: dark ? "#f2f2f2" : "#0a0a0a",
          },
        });
        const { svg } = await mermaid.render(`mmd${id}`, source);
        if (live) setSvg(svg);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [id, source]);

  return (
    <div className="md-diagram">
      <div className="md-code-bar">
        <span>{failed ? "Diagram (couldn't be drawn)" : "Diagram"}</span>
        {!failed ? (
          <button type="button" onClick={() => setShowSource(!showSource)}>
            {showSource ? "View diagram" : "View source"}
          </button>
        ) : null}
      </div>
      {failed || showSource ? (
        <pre>
          <code>{source}</code>
        </pre>
      ) : svg ? (
        <div className="md-diagram-svg" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="md-diagram-svg text-[13px] text-mute">Drawing…</div>
      )}
    </div>
  );
}
