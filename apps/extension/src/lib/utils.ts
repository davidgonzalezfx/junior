import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui class merge helper (manual install — docs/decisions.md 2026-10-23).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
