import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Drawer/Dialog box(Sheet/Dialog)of onInteractOutside Turn off judgment assistance。
//
// Background:Inside the drawer Radix Elastic layer(Select Drop down、DropdownMenu、Popover etc.)Will portal to drawer
// outside. Click mask when the elastic layer is turned on/Want to put it away outside the drawer,This time pointerdown will be Select and Sheet Two
// DismissableLayer Simultaneous processing;Select Close first and yes discrete Event、React Will synchronize flush,So
// Turn Sheet The processor is elastic layer data-state Already translated into closed —— in"Present"Detect whether the elastic layer is open
// Naturally unreliable(Actual measurement has verified)。
//
// Correct approach:Radix of pointerdown Listening in the bubbling phase;We are capture Stage(earlier than it)First
// "Is there any elastic layer open at this moment?"Record it,onInteractOutside Read this record value again to decide whether to release the shutdown。
function isRadixOverlayOpenNow(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(
    [
      "[data-slot='select-trigger'][data-state='open']",
      "[data-slot='select-content'][data-state='open']",
      "[role='listbox'][data-state='open']",
      "[data-radix-popper-content-wrapper]",
      "[aria-expanded='true'][data-state='open']",
    ].join(","),
  );
}

let overlayOpenAtLastPointerDown = false;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    () => {
      overlayOpenAtLastPointerDown = isRadixOverlayOpenNow();
    },
    true, // capture:Get it first Radix In the bubbling stage pointerdown Processor previous record
  );
}

// radixOverlayWasOpenAtPointerDown Back"Most recent pointerdown Is there any Radix Elastic layer
// On"。Drawer/dialog box accordingly:Point masking when elastic layer is on → Only the elastic layer is collected, not the self。
export function radixOverlayWasOpenAtPointerDown(): boolean {
  return overlayOpenAtLastPointerDown;
}

// copyText Write text to clipboard,Return whether successful。
// Background:navigator.clipboard Only in security context(HTTPS / localhost)Available;Passed IP + HTTP
// When accessed it is undefined,Downgrade to execCommand("copy")。
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continue with the downgrade plan
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export const getInitials = (str: string): string => {
  if (typeof str !== "string" || !str.trim()) return "?";

  return (
    str
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "?"
  );
};

export function formatCurrency(
  amount: number,
  opts?: {
    currency?: string;
    locale?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    noDecimals?: boolean;
  },
) {
  const { currency = "USD", locale = "en-US", minimumFractionDigits, maximumFractionDigits, noDecimals } = opts ?? {};

  const formatOptions: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
    minimumFractionDigits: noDecimals ? 0 : minimumFractionDigits,
    maximumFractionDigits: noDecimals ? 0 : maximumFractionDigits,
  };

  return new Intl.NumberFormat(locale, formatOptions).format(amount);
}
