import { Bug, Compass, FolderSearch, Globe, type LucideIcon } from "lucide-react";
import { BrandMark } from "./brand";

const suggestions: { icon: LucideIcon; text: string }[] = [
  { icon: FolderSearch, text: "Explore this workspace and explain how it is organized" },
  { icon: Bug, text: "Find a failing test and fix it" },
  { icon: Globe, text: "Research a topic on the web and cite sources" },
  { icon: Compass, text: "Plan a new feature step by step before writing code" },
];

export function EmptyState({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  return (
    <div className="empty-state">
      <BrandMark size={44} />
      <h1 className="empty-state__title">What should we build today?</h1>
      <p className="empty-state__tagline">
        Tatvam explores your workspace, plans the work and keeps you in control.
      </p>
      <div className="suggestions">
        {suggestions.map(({ icon: Icon, text }) => (
          <button key={text} type="button" className="suggestion" onClick={() => onSuggestion(text)}>
            <Icon size={17} aria-hidden="true" className="suggestion__icon" />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
