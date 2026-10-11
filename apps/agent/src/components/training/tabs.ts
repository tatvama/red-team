// Shared by the server page (which reads ?tab=) and the client app, so it must not be a client module.

export const trainingTabs = [
  { id: "review", label: "Review" },
  { id: "datasets", label: "Datasets" },
  { id: "evaluations", label: "Evaluations" },
  { id: "distillation", label: "Distillation" },
  { id: "finetuning", label: "Fine-tuning" },
  { id: "models", label: "Models" },
] as const;

export type TrainingTabId = (typeof trainingTabs)[number]["id"];

export function parseTrainingTab(value: string | string[] | undefined): TrainingTabId {
  const raw = Array.isArray(value) ? value[0] : value;
  return trainingTabs.find((tab) => tab.id === raw)?.id ?? "review";
}
