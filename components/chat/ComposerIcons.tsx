/** Icons for the message box's extras, drawn like the others in icons.tsx. */
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

/** A light bulb: think harder. Filled when on. */
export const ThinkIcon = ({ on, ...p }: P & { on?: boolean }) => (
  <svg {...base} {...p}>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" fill={on ? "currentColor" : "none"} />
  </svg>
);

/** A bookmarked page: saved prompts. */
export const PromptsIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 3.5h12v17l-6-4-6 4z" />
  </svg>
);

/** A clock: queued to send after the reply. */
export const LaterIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5l3 2" />
  </svg>
);
