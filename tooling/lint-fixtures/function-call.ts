export function make(body: string): unknown {
  return Function(body);
}
