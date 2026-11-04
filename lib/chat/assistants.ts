/** Saved assistants. Shared by the server and the browser. */
import type { ProjectFile } from "./projects";

export type AssistantRow = {
  id: string;
  name: string;
  description: string;
  model: string | null;
  shared: boolean;
  /** You made it (so you can change it); otherwise someone in your family shared it. */
  mine: boolean;
};

export type AssistantDetail = AssistantRow & { instructions: string; files: ProjectFile[] };

export const MAX_ASSISTANT_NAME = 60;
export const MAX_ASSISTANT_DESCRIPTION = 200;
export const MAX_ASSISTANT_INSTRUCTIONS = 8000;
export const MAX_ASSISTANT_FILES = 20;

export const cleanAssistantName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, MAX_ASSISTANT_NAME);
