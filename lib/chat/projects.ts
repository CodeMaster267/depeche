/** Projects (folders of chats with their own instructions and files). Shared by server and browser. */
import type { FileRef } from "./files";

export type ProjectRow = { id: string; name: string; updated_at: string };

export type ProjectFile = FileRef & { id: string };

export type ProjectDetail = ProjectRow & { instructions: string; files: ProjectFile[] };

export const MAX_PROJECT_NAME = 100;
export const MAX_PROJECT_INSTRUCTIONS = 8000;
export const MAX_PROJECT_FILES = 20;

export const cleanProjectName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, MAX_PROJECT_NAME);
