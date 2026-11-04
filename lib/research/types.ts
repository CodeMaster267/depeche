import type { Source } from "@/lib/chat/thread";

/** What the browser reads of a research run (its own runs only, by row-level security). */
export const RUN_COLUMNS =
  "id, chat_id, question_id, model, status, phase, title, questions, notes, sources, searches, cost_usd, error, report_id, created_at, updated_at";

export type RunView = {
  id: string;
  chat_id: string;
  question_id: string;
  model: string;
  status: "running" | "done" | "failed" | "stopped";
  phase: "planning" | "researching" | "writing";
  title: string | null;
  questions: string[];
  notes: { question: string; text: string; failed?: boolean }[];
  sources: Source[];
  searches: number;
  cost_usd: number | string;
  error: string | null;
  report_id: string | null;
  created_at: string;
  updated_at: string;
};
