/** Voice icons, in the same thin line style as components/chat/icons.tsx. */
type P = { className?: string };
const base = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const MicIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </svg>
);
export const WaveIcon = (p: P) => (
  <svg {...base} strokeWidth={1.9} {...p}>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3" />
  </svg>
);
export const SpeakerIcon = (p: P) => (
  <svg {...base} width={18} height={18} {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);
export const StopSpeakingIcon = (p: P) => (
  <svg {...base} width={18} height={18} {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);
