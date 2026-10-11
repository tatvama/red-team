import { AgentApp } from "@/components/agent-app";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentApp initialConversationId={id} />;
}
