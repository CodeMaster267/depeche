"use client";

import { createContext, useContext } from "react";
import type { ProjectRow } from "@/lib/chat/projects";

/** Your projects, for the chat menu's "Move to project" and the chat list. */
export type ProjectsValue = {
  projects: ProjectRow[];
  /** Makes a project and adds it to the list. */
  create: (name: string) => Promise<ProjectRow | null>;
};

export const ProjectsContext = createContext<ProjectsValue | null>(null);
export const useProjects = () => useContext(ProjectsContext);
