export function save(note: string): void {
  localStorage.setItem('note', note);
}
