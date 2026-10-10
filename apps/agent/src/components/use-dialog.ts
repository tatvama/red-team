"use client";

import { type RefObject, useEffect } from "react";

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog behaviour: moves focus in on mount (to `initialFocus`, then `[data-autofocus]`, then the
 * first focusable element), gives it back on unmount, closes on Escape and keeps Tab inside.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, initialFocus?: string) {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    const target =
      (initialFocus ? dialog?.querySelector<HTMLElement>(initialFocus) : null) ??
      dialog?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => previous?.focus();
  }, [ref, initialFocus]);

  // Listens on the document so Escape and the focus trap still work after focus falls to <body>
  // (for example when the focused button becomes disabled).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = ref.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => !element.closest("[hidden]"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ref, onClose]);
}
