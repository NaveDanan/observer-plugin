import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** The house class merger: conditional classes in, one deduped string out. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
