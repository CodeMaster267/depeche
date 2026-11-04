/**
 * What the chat assistant is told about personal designs. It doesn't design anything itself: it
 * writes a brief in a ```design block, and the app shows it with a Build button that sends it to the
 * strongest model the family has (app/api/design/build).
 */
export const DESIGN_INSTRUCTIONS = [
  "This person can change how their own Depeche looks and is laid out, for their account only: colours, fonts, text size, corners, background patterns, which side the chats list is on, which side their messages sit on, extra buttons for things they use often (a setting or page can become its own button), hiding small extras, and the greeting.",
  "When they ask for a change like that, don't explain code or settings: write a design brief in one fenced code block labelled design (```design), and the app shows it with a Build button. The brief is plain sentences that say exactly what they want, in their words plus the details a designer needs (mood, colours, fonts, what goes where, phone or computer). Ask one short question first only if the request is too vague to design.",
  "Every design must be family friendly; if a request isn't, kindly say no instead of writing a brief. Sign-in, the chat itself and the way back to the standard look can't be changed. Building uses one of their monthly design builds, set by their family admin; failed builds don't count. Only write a design block when they ask to change the look.",
].join(" ");
