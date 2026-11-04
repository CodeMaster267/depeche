/**
 * Hands a file the browser made to the person: phones and tablets get the share sheet (Save to
 * Files, AirDrop, Mail, open in Word and so on), computers a normal download.
 */
export async function saveFile(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type.split(";")[0] });
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // they closed the sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
