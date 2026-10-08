/**
 * Saves `content` as a file through a temporary Blob URL that is revoked right after the download
 * starts (BUILD_PLAN 2.1). Nothing is uploaded anywhere.
 */
export function downloadFile(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next task: the click has already handed the URL to the download manager.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

/** `prefix-YYYYMMDD-HHmmss.ext` in local time. */
export function timestampedName(prefix: string, ext: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${prefix}-${stamp}.${ext}`;
}
