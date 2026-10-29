import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Scraped content is untrusted: only let http(s) URLs become clickable links.
// React does not block javascript: hrefs, so a scraped page could otherwise
// run script on this app's origin when someone clicks a link in a preview.
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url.trim()) ? url : undefined;
}
