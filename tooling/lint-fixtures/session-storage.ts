export function save(note: string): void {
  window.sessionStorage.setItem('note', note);
}
