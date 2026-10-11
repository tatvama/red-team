import type { Metadata } from "next";
import { parseTrainingTab } from "@/components/training/tabs";
import { TrainingApp } from "@/components/training/training-app";

export const metadata: Metadata = {
  title: "Training · Tatvam",
};

export default async function TrainingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  return <TrainingApp initialTab={parseTrainingTab(tab)} />;
}
