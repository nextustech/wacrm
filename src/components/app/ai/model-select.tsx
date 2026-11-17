/**
 * Model picker backed by the workspace's own AI providers (`ai_providers` +
 * `ai_models`) rather than hardcoded ids. Free-typed model fields silently 404
 * at request time once a provider retires a model, which is invisible until a
 * reply comes back empty.
 */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAiProviderOptions } from "@/hooks/use-ai-settings";

/** Gateway-style ids ("google/gemini-3.8-flash") name the same model as bare ones. */
function bareId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

export function ModelSelect({
  workspaceId,
  providerId,
  value,
  onChange,
  placeholder = "Select a model",
}: {
  workspaceId: string | undefined;
  /** Pins the list to one provider. Vendors never share model ids, so an
   *  OpenAI-bound record must not be offered a Gemini model. */
  providerId?: string | null;
  value: string;
  onChange: (modelId: string) => void;
  placeholder?: string;
}) {
  const { data: providers, isLoading } = useAiProviderOptions(workspaceId);

  const scoped = providerId
    ? (providers ?? []).filter((p) => p.id === providerId)
    : (providers ?? []);

  // The model field doesn't record which provider it came from, so the same id
  // offered by two providers is one choice here.
  const seen = new Set<string>();
  const groups: { id: string; name: string; models: { id: string; label: string }[] }[] = [];
  for (const provider of scoped) {
    const models = provider.models.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    if (models.length) groups.push({ id: provider.id, name: provider.name, models });
  }

  const match = groups.flatMap((g) => g.models).find((m) => bareId(m.id) === bareId(value));

  return (
    <>
      <Select value={match?.id ?? value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={isLoading ? "Loading models…" : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {/* A model saved before it was retired stays visible instead of reading as blank. */}
          {value && !match && <SelectItem value={value}>{value} · unavailable</SelectItem>}
          {groups.map((group) => (
            <SelectGroup key={group.id}>
              <SelectLabel>{group.name}</SelectLabel>
              {group.models.map((m) => (
                <SelectItem key={`${group.id}:${m.id}`} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {!isLoading && groups.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          No AI provider is set up yet — add one in Settings → AI.
        </p>
      )}
    </>
  );
}
