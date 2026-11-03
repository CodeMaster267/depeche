import { Wordmark } from "@/components/Wordmark";

/**
 * Depeche's loading state: the glitched wordmark, re-jolting on a loop like a signal searching for
 * lock, with a thin scan line under it. Used while a page loads. With reduced motion it is the
 * still wordmark, gently fading.
 */
export function Loader({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="loader flex flex-col items-center gap-5">
      <Wordmark glitch className="text-[clamp(28px,9vw,44px)]" />
      <span aria-hidden="true" className="loader-scan" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
