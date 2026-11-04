"use client";

import { Widget } from "@/components/markdown/Widget";

/** A saved gadget at full width, remembering what it saves. */
export function GadgetView({ id, title, html }: { id: string; title: string; html: string }) {
  return <Widget key={html} title={title} html={html} streaming={false} gadgetId={id} full />;
}
