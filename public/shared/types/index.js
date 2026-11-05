// Canvas type registry. To add a canvas type: create shared/types/<name>.js exporting
// { type, create, apply, diff, describe, read? , recalc? } and register it here, then add
// a browser view in public/canvases/<name>/view.js.
import * as sheet from './sheet.js';
import * as text from './text.js';
import * as studio from './studio.js';

export const TYPES = { sheet, text, studio };

/** Apply one op to a doc. Handles the generic `__restore` op for any type. */
export function applyDocOp(doc, op) {
  const T = TYPES[doc.type];
  if (!T) throw new Error(`Unknown canvas type "${doc.type}"`);
  if (op.op === '__restore') {
    const before = JSON.parse(JSON.stringify(doc));
    replaceInPlace(doc, JSON.parse(JSON.stringify(op.state)));
    return { inverse: [{ op: '__restore', state: before }], changes: T.diff(before, doc) };
  }
  return T.apply(doc, op);
}

export function replaceInPlace(target, src) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, src);
}
