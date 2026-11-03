# spread-viz/1 — SVG visual packs

A **pack** turns one value into a picture: a lamp that is on or off, a gauge from 0 to 100, or one of 2–12 status
images. A pack is one JSON object. Spread shows it in the grid (`=VIZ("pack", B7)` in a cell, or a visual card) and
in Live, where values glide and states cross-fade. The same file works everywhere; nothing in it runs code.

Install: paste the JSON in 🎨 → *Install a pack*, or `cm viz add pack.json`, or `POST /api/viz`.
Check without installing: `cm viz check pack.json` / `POST /api/viz?dry=1` — errors say exactly what to fix.

## The three kinds

| kind | the value is… | you write | Spread sets on the `<svg>` root |
|---|---|---|---|
| `toggle` | on / off | one `svg` that styles `[data-state="on"]` and `[data-state="off"]` | `data-state="on|off"` |
| `range` | a number between `min` and `max` (default 0–100) | one `svg` that uses `var(--v)` (0…1), `var(--pct)` (0…100) and/or `[data-level="0".."10"]` | `--v`, `--pct`, `--level`, `data-level` |
| `states` | one of 2–12 named states | one `svg` per state, each with a rule that picks it | `data-state="<state id>"` |

**Toggle** is on for `true`, a non-zero number, or the words on, yes, true, ok, done, up, open, green, active
(case-insensitive; also kyllä, päällä, valmis). Change it with `"on": {"when": ">", "value": 50}`.

**States** are tried in order; the first whose rule matches wins. Give the last state `"when": "any"` as the
fallback (otherwise the first state is the fallback).

## Rules (`states[].when` / `on.when`)

`<` `<=` `>` `>=` `=` `<>` `between` (with `value2`) `contains` `empty` `notEmpty` `any`.
Numbers compare as numbers, text compares case-insensitively. For `=` and `contains`, `value` may be a list:
`"value": ["ok", "done", "valmis"]`. Numeric rules never match text.

## Text placeholders

Anywhere in text: `{{value}}` (the value as shown in the cell), `{{pct}}` (0–100, range), `{{label}}` (the card's
label or the state's `label`), `{{state}}`. They are inserted as text (escaped), never as markup.

## Fields

```json
{
  "spec": "spread-viz/1",          // required, exactly this
  "id": "water-tank",              // required: a-z 0-9 -, max 40, unique
  "kind": "range",                 // toggle | range | states
  "name": "Water tank",            // shown in the picker (max 60)
  "description": "Fill level",     // optional, max 300
  "author": "…",                   // optional
  "min": 0, "max": 100,            // range only
  "on": { "when": ">", "value": 0 },// toggle only, optional
  "svg": "<svg viewBox=…>…</svg>", // toggle and range
  "states": [                      // states only: 2–12
    { "id": "ok", "label": "OK", "when": "=", "value": ["ok", "done"], "svg": "<svg viewBox=…>…</svg>" },
    { "id": "unknown", "label": "?", "when": "any", "svg": "<svg viewBox=…>…</svg>" }
  ]
}
```

## SVG rules (checked on install; anything else is removed when shown)

- Exactly one `<svg>` root **with a `viewBox`**. Width/height are set by Spread; draw for any size.
- Max 64 KB per SVG, 256 KB per pack.
- Allowed: shapes, paths, text, groups, `defs`, gradients, patterns, clip paths, masks, markers, filters
  (`feGaussianBlur`, `feDropShadow`, `feColorMatrix`, …), `<style>`, `<use href="#id">`, and SMIL animation
  (`animate`, `animateTransform`, `set`).
- Not allowed: `<script>`, event attributes (`onload=` …), `<foreignObject>`, `<image>`, `<iframe>`, external
  links or fonts — `href` and `url()` may only point inside the SVG (`#id`). No `@import`, no `javascript:`.
- Use `currentColor` for "ink": it is white on Live's dark glass and dark in the grid and on bright backgrounds.
- Styles inside the SVG stay inside it (each visual is isolated).

## Making it move

Spread transitions `fill`, `stroke`, `opacity`, `transform` and `stroke-dashoffset` (≈0.5 s), so CSS driven by
`--v` or `data-state` animates by itself when the value changes:

```css
.needle { transform-origin: 50px 58px; transform: rotate(calc(var(--v) * 270deg - 135deg)); }
.fill   { transform-box: fill-box; transform-origin: left center; transform: scaleX(var(--v)); }
.arc    { stroke-dasharray: 100; stroke-dashoffset: calc((1 - var(--v)) * 100); }   /* with pathLength="100" */
[data-level="8"] .arc, [data-level="9"] .arc, [data-level="10"] .arc { stroke: #ea4335; }
[data-state="on"] .bulb { fill: #ffd54a; }
```

Prefer `transform` / `stroke-dashoffset` over changing `width`/`height` — they work everywhere.

## A complete example

```json
{
  "spec": "spread-viz/1", "id": "water-tank", "kind": "range", "name": "Water tank", "min": 0, "max": 100,
  "svg": "<svg viewBox=\"0 0 80 100\"><style>.w{fill:#4ea1ff;transform-box:fill-box;transform-origin:center bottom;transform:scaleY(var(--v))}[data-level=\"0\"] .w,[data-level=\"1\"] .w{fill:#ea4335}.t{font:700 16px system-ui;fill:currentColor;text-anchor:middle}</style><rect x=\"10\" y=\"6\" width=\"60\" height=\"80\" rx=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"4\"/><rect class=\"w\" x=\"14\" y=\"10\" width=\"52\" height=\"72\" rx=\"5\"/><text class=\"t\" x=\"40\" y=\"98\">{{pct}}%</text></svg>"
}
```

## Using a pack

- In a cell: `=VIZ("water-tank", B7)` or `=VIZ("status", C7, "API")` — the cell keeps the value (sorting, SQL and
  formulas see it), and draws the picture. Put it in a table column for a status column.
- As a card: 🎨 → *Card*, or `cm viz card water-tank Project!C12 --at K2 [--title "Tank"] [--size small]`.
- Built in: `lamp`, `switch` (toggle) · `gauge`, `battery`, `ring` (range) · `traffic`, `status`, `weather` (states).
