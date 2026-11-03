import { Loader } from "@/components/Loader";

/** Shown while any page loads. */
export default function Loading() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <Loader />
    </main>
  );
}
