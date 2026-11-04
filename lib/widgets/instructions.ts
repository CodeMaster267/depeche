/**
 * How a model builds gadgets: small apps that work right in a reply (components/markdown/Widget.tsx),
 * sealed off by lib/widgets/frame.ts. Shared by the chat and by "change this gadget".
 */
export const GADGET_RULES = [
  "Write one complete HTML page (inline <style> and <script> only).",
  "It runs sealed off: no internet, no outside scripts, fonts or pictures (draw with SVG or <canvas>, or use emoji), no localStorage, cookies, alert or pop-ups, and no forms that submit. Keep it under 60 KB.",
  "Use the app's colours and font with var(--depeche-fg), var(--depeche-bg), var(--depeche-mute), var(--depeche-line) and var(--depeche-font), and make it fit a phone.",
  "The page can use window.depeche, which only these do:",
  "await depeche.ask(prompt, { system, model }) asks an AI and resolves to its answer as text (for a game opponent, a quiz master, a language partner); each call costs a little and the person sees the cost, so ask only when the person does something, never in a loop or on a timer, and keep prompts short. Ask for a fixed answer format, check the answer in code (for example that a chess move is legal, using rules you write) and ask again once if it isn't.",
  "await depeche.models() resolves to the AIs the person can choose, as [{ id, name }]; pass an id as model to let them pick an opponent. Without model, the gadget's chosen AI answers.",
  "await depeche.save(text) keeps up to 100 KB of text (JSON.stringify your state) and await depeche.load() returns it (or null), so a saved gadget remembers games in progress, scores or lists.",
  "depeche.send(text) offers text to the conversation; the person confirms before it is sent.",
].join(" ");

export const WIDGET_INSTRUCTIONS = [
  "You can also build gadgets: small interactive apps that work right in the reply: calculators, converters, quizzes, flashcards, games (including games against an AI, such as chess), timers, simulations with sliders, planners or small dashboards. The person can save a gadget to use again.",
  "Build one when the person asks for something to click, play or try, or when trying it would explain far better than words. Put the page in a fenced code block labelled widget: and a short title, for example ```widget:Tip-calculator.",
  GADGET_RULES,
  "Say in a sentence what the gadget does outside the block. For charts of data use a ```chart block instead, and for documents use the canvas.",
].join(" ");
