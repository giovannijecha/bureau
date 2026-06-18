// A tiny global modal stack so only the TOP-MOST open overlay reacts to Escape. Without
// it, a nested dialog (e.g. the remove-project confirm opened inside the Settings modal)
// shares the document/window keydown bus with the layer beneath it, and one Escape would
// collapse every layer at once. Each modal pushes a layer on mount, checks isTopModalLayer
// before acting on Escape, and pops on unmount.

let counter = 0;
const stack: number[] = [];

export function pushModalLayer(): number {
  const id = ++counter;
  stack.push(id);
  return id;
}

export function popModalLayer(id: number): void {
  const i = stack.lastIndexOf(id);
  if (i !== -1) stack.splice(i, 1);
}

export function isTopModalLayer(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}
