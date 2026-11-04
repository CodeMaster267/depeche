"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MODELS, PROVIDERS, priceBand, type Model } from "@/lib/ai/models";
import { MAX_COMPARE, toggleCompare } from "@/lib/chat/compare";
import { CheckIcon, CloseIcon, SearchIcon } from "./icons";

/**
 * Choose a model: a sheet from the bottom on phones, a panel on larger screens. Only models whose
 * provider the family has a key for are offered.
 */
export function ModelPicker({
  available,
  current,
  onPick,
  onClose,
  comparing,
  onCompare,
}: {
  available: string[];
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
  /** Models chosen to answer the next message side by side (empty when not comparing). */
  comparing?: string[];
  /** Ask two or three models at once; an empty list turns comparing off. */
  onCompare?: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  // Comparing: tap two or three models, then confirm. Starts with the current model ticked.
  const [multi, setMulti] = useState(Boolean(comparing?.length));
  const [chosen, setChosen] = useState<string[]>(
    comparing?.length ? comparing : current && available.includes(current) ? [current] : [],
  );
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const models = MODELS.filter(
      (m) => available.includes(m.id) && (!needle || `${m.name} ${m.tags.join(" ")}`.toLowerCase().includes(needle)),
    );
    // Chat models by provider, then the models that make pictures together under their own heading.
    return [
      ...PROVIDERS.map((p) => ({ key: p.id, title: p.name.split(" (")[0], models: models.filter((m) => m.provider === p.id && !m.image) })),
      // Comparing is for written answers, so picture models aren't offered then.
      { key: "pictures", title: "Make pictures", models: multi ? [] : models.filter((m) => m.image) },
    ].filter((g) => g.models.length);
  }, [available, q, multi]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:pt-[12vh]" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a model"
        className="enter-glitch relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-bg outline-none sm:max-w-[480px] sm:rounded-[24px] sm:border sm:border-line"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between px-6 pb-3 pt-4">
          <h2 className="text-[26px] font-semibold tracking-tight">Choose a model</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 p-2 text-mute">
            <CloseIcon />
          </button>
        </div>
        <label className="mx-6 mb-2 flex h-12 items-center gap-2 rounded-2xl bg-soft px-4 text-mute">
          <SearchIcon />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models"
            aria-label="Search models"
            className="h-full w-full bg-transparent text-[17px] text-fg outline-none placeholder:text-faint"
          />
        </label>
        {onCompare && available.length > 1 ? (
          <div className="mx-6 mb-1 mt-2 flex items-center justify-between gap-3">
            <span className="text-[15px] text-mute">
              {multi ? `Pick 2 or ${MAX_COMPARE} models to answer side by side` : "Ask several models at once"}
            </span>
            <button
              type="button"
              aria-pressed={multi}
              onClick={() => setMulti(!multi)}
              className={`press shrink-0 rounded-full border px-3.5 py-1.5 text-[14px] ${multi ? "border-fg bg-inv text-on-inv" : "border-line"}`}
            >
              Compare
            </button>
          </div>
        ) : null}
        <div className="overflow-y-auto overscroll-contain pb-4">
          {groups.map((g) => (
            <section key={g.key}>
              <h3 className="px-6 pb-1 pt-5 text-[12px] font-semibold uppercase tracking-[0.1em] text-mute">
                {g.title}
              </h3>
              <ul>
                {g.models.map((m) =>
                  multi ? (
                    <ModelRow
                      key={m.id}
                      model={m}
                      selected={chosen.includes(m.id)}
                      order={chosen.includes(m.id) ? chosen.indexOf(m.id) + 1 : undefined}
                      disabled={!chosen.includes(m.id) && chosen.length >= MAX_COMPARE}
                      onPick={(id) => setChosen((c) => toggleCompare(c, id))}
                    />
                  ) : (
                    <ModelRow key={m.id} model={m} selected={m.id === current} onPick={onPick} />
                  ),
                )}
              </ul>
            </section>
          ))}
          {!groups.length ? <p className="px-6 py-6 text-[15px] text-mute">No models match.</p> : null}
        </div>
        {multi && onCompare ? (
          <div className="flex items-center gap-3 border-t border-line px-6 py-3">
            {comparing?.length ? (
              <button type="button" className="press rounded-full px-3 py-2.5 text-[15px] text-mute" onClick={() => onCompare([])}>
                Stop comparing
              </button>
            ) : null}
            <button
              type="button"
              disabled={chosen.length < 2}
              onClick={() => onCompare(chosen)}
              className="press glass ml-auto rounded-full px-5 py-2.5 text-[16px] font-medium disabled:opacity-40"
            >
              {chosen.length < 2 ? "Pick at least 2" : `Compare ${chosen.length} models`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ModelRow({
  model,
  selected,
  onPick,
  order,
  disabled,
}: {
  model: Model;
  selected: boolean;
  onPick: (id: string) => void;
  /** In compare mode: this model's place in the row of answers. */
  order?: number;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(model.id)}
        aria-pressed={selected}
        disabled={disabled}
        className={`flex w-full items-center justify-between gap-4 border-b border-line px-6 py-3.5 text-left disabled:opacity-40 ${selected ? "bg-soft" : ""}`}
      >
        <span className="min-w-0">
          <span className="block text-[18px]">{model.name}</span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {[...model.tags, priceBand(model)].map((t) => (
              <span key={t} className="rounded-full border border-line px-2.5 py-0.5 text-[13px] text-mute">
                {t}
              </span>
            ))}
          </span>
        </span>
        {order ? (
          <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-inv font-mono text-[13px] text-on-inv">
            {order}
          </span>
        ) : selected ? (
          <CheckIcon className="shrink-0" />
        ) : null}
      </button>
    </li>
  );
}
