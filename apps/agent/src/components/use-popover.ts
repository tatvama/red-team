"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

/**
 * Open state for a trigger button and its floating panel. Closes on Escape (returning focus to the
 * trigger) and on any pointer press outside both; focuses the checked or first item when opened.
 */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<T>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const initial =
      panel?.querySelector<HTMLElement>(`${ITEM_SELECTOR}[aria-checked="true"]`) ??
      panel?.querySelector<HTMLElement>(ITEM_SELECTOR);
    initial?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Capture phase so an open popover consumes Escape before drawers or dialogs underneath react.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return { open, setOpen, close, triggerRef, panelRef };
}

/** Arrow, Home and End move focus between menu items; Tab closes the menu. */
export function onMenuKeyDown(event: KeyboardEvent<HTMLElement>, close: (restoreFocus?: boolean) => void) {
  if (event.key === "Tab") {
    close(false);
    return;
  }
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const target = (() => {
    switch (event.key) {
      case "ArrowDown":
        return items[(index + 1) % items.length];
      case "ArrowUp":
        return items[(index - 1 + items.length) % items.length];
      case "Home":
        return items[0];
      case "End":
        return items[items.length - 1];
      default:
        return null;
    }
  })();
  if (target) {
    event.preventDefault();
    target.focus();
  }
}
