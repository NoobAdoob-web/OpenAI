// Notes about HOW data was read (which source worked, which didn't).
// Never contains names, numbers or chat content: it goes into the Get help message.

const notes = new Map<string, string>();

export function note(key: string, value: string): void {
  notes.set(key, value);
}

export function allNotes(): Record<string, string> {
  return Object.fromEntries(notes);
}
