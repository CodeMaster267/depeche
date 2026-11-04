"use client";

import { useState } from "react";
import { ConciergePanel } from "@/components/help/Concierge";

/** Opens Concierge straight away; closing it leaves a way back in. */
export function HelpPage({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-5 py-10">
      <h1 className="text-[34px] font-semibold tracking-tight">Concierge</h1>
      <p className="text-[15px] text-mute">Ask how anything in Depeche works: where a setting lives, what a button does, how to add a key.</p>
      <button type="button" onClick={() => setOpen(true)} className="press glass glass-pill self-start px-5 py-3 text-[16px] font-medium">
        Ask Concierge
      </button>
      {open ? <ConciergePanel isAdmin={isAdmin} onClose={() => setOpen(false)} /> : null}
    </main>
  );
}
