"use client";

import clsx from "clsx";
import { Ellipsis, LogOut, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Trash2, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type ConversationSummary, type ModelConnection, type Provider, providerNames } from "@/lib/contract";
import { groupConversations } from "@/lib/client/format";
import { BrandMark, Wordmark } from "./brand";
import { ConnectionDot, connectionMessage, connectionStatus } from "./model-picker";
import { onMenuKeyDown, usePopover } from "./use-popover";

const MENU_WIDTH = 184;

type ItemProps = {
  conversation: ConversationSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
};

function ConversationItem({ conversation, active, onSelect, onRename, onDelete, onError }: ItemProps) {
  const { open, setOpen, close, triggerRef, panelRef } = usePopover();
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const linkRef = useRef<HTMLButtonElement>(null);
  const renameSettled = useRef(false);

  // The list scrolls, so the menu is fixed-positioned from the trigger and closes when the list moves.
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [open, panelRef, setOpen]);

  useEffect(() => {
    if (confirming) panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [confirming, panelRef]);

  function toggleMenu() {
    const trigger = triggerRef.current;
    if (!open && trigger) {
      const rect = trigger.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      const openUp = window.innerHeight - rect.bottom < 150;
      setMenuStyle(
        openUp ? { left, bottom: window.innerHeight - rect.top + 4 } : { left, top: rect.bottom + 4 },
      );
      setConfirming(false);
    }
    setOpen(!open);
  }

  function startRename() {
    renameSettled.current = false;
    close(false);
    setRenaming(true);
  }

  /** Enter, Escape and blur can all end an edit; only the first one counts. */
  async function finishRename(title: string | null, restoreFocus: boolean) {
    if (renameSettled.current) return;
    renameSettled.current = true;
    setRenaming(false);
    if (restoreFocus) requestAnimationFrame(() => linkRef.current?.focus());
    const trimmed = title?.trim();
    if (!trimmed || trimmed === conversation.title) return;
    try {
      await onRename(conversation.id, trimmed.slice(0, 120));
    } catch {
      onError("Could not rename the task. Please try again.");
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      await onDelete(conversation.id);
    } catch {
      onError("Could not delete the task. Please try again.");
      setBusy(false);
      close();
    }
  }

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void finishRename(event.currentTarget.value, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finishRename(null, true);
    }
  }

  return (
    <li className={clsx("conv-item", active && "conv-item--active", open && "conv-item--menu-open")}>
      {renaming ? (
        <input
          className="conv-item__rename"
          aria-label="Task name"
          defaultValue={conversation.title}
          maxLength={120}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={onRenameKeyDown}
          onBlur={(event) => void finishRename(event.currentTarget.value, false)}
        />
      ) : (
        <button
          ref={linkRef}
          type="button"
          className="conv-item__link"
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(conversation.id)}
          title={conversation.title}
        >
          {conversation.title}
        </button>
      )}
      {!renaming && (
        <button
          ref={triggerRef}
          type="button"
          className="conv-item__more"
          aria-label={`Options for ${conversation.title}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggleMenu}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div
          ref={panelRef}
          className="popover conv-menu"
          style={{ ...menuStyle, width: MENU_WIDTH }}
          role="menu"
          aria-label={`Options for ${conversation.title}`}
          onKeyDown={(event) => onMenuKeyDown(event, close)}
        >
          {confirming ? (
            <div className="conv-menu__confirm">
              <p>Delete this task? This cannot be undone.</p>
              <div className="conv-menu__confirm-actions">
                <button type="button" role="menuitem" className="button button--ghost button--small" onClick={() => close()}>
                  Cancel
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-autofocus
                  className="button button--danger button--small"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={startRename}
              >
                <Pencil size={14} aria-hidden="true" />
                <span className="menu-item__label">Rename</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item menu-item--danger"
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span className="menu-item__label">Delete</span>
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

type SidebarProps = {
  conversations: ConversationSummary[];
  activeId: string | null;
  /** Icon-only rail on desktop. */
  collapsed: boolean;
  /** Drawer state on narrow screens. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onToggleCollapsed: () => void;
  onNewTask: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpenSettings: () => void;
  /** Shown when the app is reached remotely and a session cookie is in use. */
  onSignOut?: () => void;
  provider: Provider;
  connection: ModelConnection | null;
};

export function Sidebar({
  conversations,
  activeId,
  collapsed,
  mobileOpen,
  onCloseMobile,
  onToggleCollapsed,
  onNewTask,
  onSelect,
  onRename,
  onDelete,
  onOpenSettings,
  onSignOut,
  provider,
  connection,
}: SidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const newTaskRef = useRef<HTMLButtonElement>(null);
  const groups = groupConversations(conversations, new Date());

  useEffect(() => {
    if (mobileOpen) newTaskRef.current?.focus();
  }, [mobileOpen]);

  return (
    <>
      <div
        className={clsx("scrim", mobileOpen && "scrim--visible")}
        aria-hidden="true"
        onClick={onCloseMobile}
      />
      <nav
        className={clsx("sidebar", collapsed && "sidebar--collapsed", mobileOpen && "sidebar--open")}
        aria-label="Tasks"
        onKeyDown={(event) => {
          if (event.key === "Escape" && mobileOpen) onCloseMobile();
        }}
      >
        <div className="sidebar__top">
          <span className="sidebar__brand">
            {collapsed ? <BrandMark size={26} /> : <Wordmark />}
          </span>
          <button
            type="button"
            className="icon-button sidebar__collapse"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button sidebar__close" aria-label="Close sidebar" onClick={onCloseMobile}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <button ref={newTaskRef} type="button" className="new-task" onClick={onNewTask} aria-label="New task">
          <Plus size={17} aria-hidden="true" />
          <span className="new-task__label">New task</span>
        </button>

        <div className="sidebar__list">
          {error && (
            <div className="sidebar__error" role="alert">
              <span>{error}</span>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setError(null)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          {groups.length === 0 && <p className="sidebar__empty">Your tasks will appear here.</p>}
          {groups.map((group) => (
            <section key={group.label} className="conv-group" aria-label={group.label}>
              <h2 className="conv-group__label">{group.label}</h2>
              <ul>
                {group.conversations.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeId}
                    onSelect={onSelect}
                    onRename={onRename}
                    onDelete={onDelete}
                    onError={setError}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="sidebar__footer">
          <button type="button" className="sidebar__settings" onClick={onOpenSettings} aria-label="Settings">
            <Settings size={17} aria-hidden="true" />
            <span className="sidebar__settings-label">Settings</span>
          </button>
          {onSignOut && (
            <button type="button" className="sidebar__settings" onClick={onSignOut} aria-label="Sign out">
              <LogOut size={17} aria-hidden="true" />
              <span className="sidebar__settings-label">Sign out</span>
            </button>
          )}
          <p className="sidebar__status" title={`${providerNames[provider]}: ${connectionMessage(provider, connection)}`}>
            <ConnectionDot connection={connection} />
            <span className="sidebar__status-text">
              {providerNames[provider]} · {connection?.state === "ready" ? "Connected" : connectionStatus(connection)}
            </span>
          </p>
        </div>
      </nav>
    </>
  );
}
