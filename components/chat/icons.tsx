/** Thin line icons, drawn in currentColor so they follow light and dark mode. */
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

export const MenuIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 8h16M4 16h10" />
  </svg>
);
export const NewChatIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 20h7M14.5 4.5l5 5L10 19H5v-5z" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const ArrowUpIcon = (p: P) => (
  <svg {...base} strokeWidth={2} {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
export const StopIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);
export const ChevronDownIcon = (p: P) => (
  <svg {...base} width={14} height={14} {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const CheckIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const CopyIcon = (p: P) => (
  <svg {...base} width={18} height={18} {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </svg>
);
export const RetryIcon = (p: P) => (
  <svg {...base} width={18} height={18} {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" />
  </svg>
);
export const MoreIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </svg>
);
export const SearchIcon = (p: P) => (
  <svg {...base} width={18} height={18} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4-4" />
  </svg>
);
export const CloseIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const SidebarIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M9.5 4.5v15" />
  </svg>
);
export const GlobeIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z" />
  </svg>
);
export const GlobeOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z" />
    <path d="M4 4l16 16" strokeWidth={2.4} stroke="var(--bg)" />
    <path d="M4 4l16 16" />
  </svg>
);
export const PaperclipIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.2-8.2a3.4 3.4 0 014.8 4.8l-8.1 8.1a1.7 1.7 0 01-2.4-2.4l7.4-7.4" />
  </svg>
);
export const FileIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5" />
  </svg>
);
export const DownloadIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" />
  </svg>
);
export const BrushIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14.5 4.5l5 5L11 18l-5-5zM6 13l-1.5 1.5C3 16 3.5 19 3.5 20.5 5 20.5 8 21 9.5 19.5L11 18" />
  </svg>
);
export const ArchiveIcon = (p: P) => (
  <svg {...base} width={20} height={20} {...p}>
    <path d="M4 7h16v12H4zM3 4h18v3H3zM10 11h4" />
  </svg>
);
export const BackIcon = (p: P) => (
  <svg {...base} width={20} height={20} {...p}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const EditIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14.5 5.5l4 4M4 20l1-5L15.5 4.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L9 19z" />
  </svg>
);
export const ChevronLeftIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14.5 6l-6 6 6 6" />
  </svg>
);
export const ChevronRightIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9.5 6l6 6-6 6" />
  </svg>
);
export const CodeIcon = (p: P) => (
  <svg {...base} width={18} height={18} {...p}>
    <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14" />
  </svg>
);
export const PersonIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c1.2-3.6 3.9-5.5 7-5.5s5.8 1.9 7 5.5" />
  </svg>
);
export const PeopleIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="9" r="3" />
    <path d="M3.5 19c.9-3 2.9-4.6 5.5-4.6s4.6 1.6 5.5 4.6" />
    <path d="M15.5 6.3a3 3 0 0 1 0 5.4M17.5 14.7c1.4.6 2.4 2 3 4.3" />
  </svg>
);
export const PulseIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 12h4l2-5 4 10 2-5h6" />
  </svg>
);
export const MemoryIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M7 4h10v16l-5-3.5L7 20z" />
  </svg>
);
export const BugIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="7.5" y="7" width="9" height="12" rx="4.5" />
    <path d="M12 11v8M7.5 12H4M20 12h-3.5M8 16.5l-3 1.5M16 16.5l3 1.5M9.5 7.5 8 5M14.5 7.5 16 5" />
  </svg>
);
export const ChevronUpDownIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
  </svg>
);
