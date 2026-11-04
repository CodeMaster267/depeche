import { Loader } from "@/components/Loader";
import { RippleField } from "@/components/RippleField";

/** Shown while any page loads: the glitched wordmark over the letterflip field. */
export default function Loading() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <RippleField className="fixed inset-0" clear="[data-ripple-clear]" />
      <div data-ripple-clear className="relative">
        <Loader />
      </div>
    </main>
  );
}
