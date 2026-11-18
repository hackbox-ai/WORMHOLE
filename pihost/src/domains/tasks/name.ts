/** Assign the display name before execution starts; no model call is required. */
export function initialTaskName(input: {name?: string; description?: string; goal?: string}): string {
  const explicit = input.name?.trim();
  if (explicit) return explicit;
  const description = input.description?.trim();
  const title = description && !["Unnamed", "Unnamed task"].includes(description)
    ? description : input.goal?.trim();
  const normalized = (title || "New task").replace(/\s+/gu, ' ');
  const characters = Array.from(normalized);
  return characters.length > 60 ? characters.slice(0, 59).join('') + '…' : normalized;
}
