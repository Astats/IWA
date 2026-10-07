export function make(body: string): unknown {
  return new Function(body);
}
