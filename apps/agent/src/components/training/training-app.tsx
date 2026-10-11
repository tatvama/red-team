"use client";

import { ArrowLeft, Boxes, ClipboardCheck, Database, FlaskConical, type LucideIcon, Sparkles, Wrench } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useCallback, useEffect, useId, useState } from "react";
import type { ModelConnection } from "@/lib/contract";
import { fetchModels } from "@/lib/client/api";
import { BrandMark } from "../brand";
import { providers } from "../model-picker";
import type { Connections } from "./common";
import { DatasetsTab } from "./datasets-tab";
import { DistillTab } from "./distill-tab";
import { EvalsTab } from "./evals-tab";
import { FinetuneTab } from "./finetune-tab";
import { ModelsTab } from "./models-tab";
import { ReviewTab } from "./review-tab";
import { type TrainingTabId, trainingTabs } from "./tabs";

const tabIcons: Record<TrainingTabId, LucideIcon> = {
  review: ClipboardCheck,
  datasets: Database,
  evaluations: FlaskConical,
  distillation: Sparkles,
  finetuning: Wrench,
  models: Boxes,
};

/** The training loop: review conversations, export datasets, evaluate, distill, fine-tune and manage models. */
export function TrainingApp({ initialTab = "review" }: { initialTab?: TrainingTabId }) {
  const [tab, setTab] = useState<TrainingTabId>(initialTab);
  const [connections, setConnections] = useState<Connections>({ ollama: null, gpu: null });
  const baseId = useId();

  const checkConnections = useCallback(() => {
    for (const provider of providers) {
      fetchModels(provider)
        .then((connection: ModelConnection) => setConnections((current) => ({ ...current, [provider]: connection })))
        .catch(() =>
          setConnections((current) => ({ ...current, [provider]: { provider, state: "offline", models: [] } })),
        );
    }
  }, []);

  useEffect(() => {
    checkConnections();
  }, [checkConnections]);

  useEffect(() => {
    document.title = "Training · Tatvam";
  }, []);

  function select(next: TrainingTabId, focus = false) {
    setTab(next);
    // Keeps the tab in the address so a reload or a shared link opens the same section.
    window.history.replaceState(null, "", next === "review" ? "/training" : `/training?tab=${next}`);
    if (focus) document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = trainingTabs.findIndex((item) => item.id === tab);
    const last = trainingTabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % trainingTabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + trainingTabs.length) % trainingTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next === -1) return;
    event.preventDefault();
    select(trainingTabs[next].id, true);
  }

  function renderTab() {
    switch (tab) {
      case "review":
        return <ReviewTab />;
      case "datasets":
        return <DatasetsTab />;
      case "evaluations":
        return <EvalsTab connections={connections} />;
      case "distillation":
        return <DistillTab connections={connections} />;
      case "finetuning":
        return <FinetuneTab />;
      case "models":
        return <ModelsTab connections={connections} />;
    }
  }

  return (
    <div className="training">
      <header className="training__header">
        <Link href="/" className="training__back">
          <ArrowLeft size={16} aria-hidden="true" />
          <span className="training__back-label">Tasks</span>
          <span className="sr-only"> (back to tasks)</span>
        </Link>
        <span className="training__brand" aria-hidden="true">
          <BrandMark size={22} />
        </span>
        <h1 className="training__title">Training</h1>
        <p className="training__subtitle">Review work, build datasets, evaluate and improve your models.</p>
      </header>
      <div className="training__tabs" role="tablist" aria-label="Training sections" onKeyDown={onTabKeyDown}>
        {trainingTabs.map((item) => {
          const Icon = tabIcons[item.id];
          return (
            <button
              key={item.id}
              id={`${baseId}-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === item.id ? 0 : -1}
              className="training__tab"
              onClick={() => select(item.id)}
            >
              <Icon size={15} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>
      <main className="training__body">
        <div
          id={`${baseId}-panel`}
          className="training__inner"
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab}`}
        >
          {renderTab()}
        </div>
      </main>
    </div>
  );
}
