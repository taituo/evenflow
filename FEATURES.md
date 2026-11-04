# Spread — every feature, and how to try it

A checklist for manual testing. **Demo** = the step of the guided tour that shows it (`cm demo`, the MCP tool
`spread_demo`, or `node bin/cm.mjs demo --step N`). Open the app at `http://127.0.0.1:3210` (`npm start`); the tour
uses its own workbook at `/#demo`.

Automated: `npm test` (engine, API, CLI, history, presence, visuals, a 2000-round undo/redo fuzz) and `npm run e2e`
(browser, two users, Live, slides, remote, phone, hostile input).

## Grid

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Full-screen canvas grid, 100k+ rows, smooth scroll | scroll fast; Ctrl+arrows jump to data edges | 1 |
| ☐ | Name box & formula bar | type `C23:D32` ↵ or a table name in the name box | |
| ☐ | Zoom 30–400 % | Ctrl+wheel / pinch; toolbar zoom | |
| ☐ | Formulas, ~50 functions, errors | `=SUM(A1:A9)`, `=IF(…)`, `=VLOOKUP(…)`; `#REF!` `#DIV/0!` `#CYCLE!` | 2 |
| ☐ | Point-and-click references while typing a formula (also other sheets) | type `=` then click cells / another tab | |
| ☐ | `A:A`, `2:2`, `Sheet!A1`, `'My sheet'!A1` refs | | |
| ☐ | Cut/paste or drag a selection by its border = one move; references follow | drag a block's border; Ctrl+X / Ctrl+V | 4 |
| ☐ | Borders move with their block | border a block, drag it | 4 |
| ☐ | Fill handle with series, Ctrl+D / Ctrl+R, Σ | | |
| ☐ | Copy/paste TSV to and from Sheets/Excel | | |
| ☐ | Fonts (8 families), sizes 9–72, bold/italic/strike, colors, align, wrap | toolbar page 1 (fonts, B/I, colors) and ⋯ page 2 (strike, align, wrap) | 1 |
| ☐ | Borders (all/inner/outer/sides; 6 styles), merged cells | ⋯ → ⊞ / ⧉ | 1, 2 |
| ☐ | Notes on cells | right-click → Insert note | |
| ☐ | Freeze rows/cols, hide gridlines | ⋯ → ❄ / # | |
| ☐ | Insert/delete rows and columns; resize + double-click autofit | right-click; header edges | |
| ☐ | Images in cells | drop an image on a cell, or `=IMAGE(url)` | |
| ☐ | Undo/redo with exact inverses (moves, deletes, merges, tables, charts, lights) | Ctrl+Z / Ctrl+Y | 21 |
| ☐ | Two-page toolbar | ⋯ switches pages (remembered) | |

## Named tables

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Many named tables per sheet, anywhere | select a block → ▦ | 2 |
| ☐ | Structured refs `Tasks[Status]`, `Tasks[#All]` | `=COUNTIF(Tasks[Status],"open")` | 2 |
| ☐ | Typing under a table grows it | | |
| ☐ | ＋ row / ＋ column handles | click a cell in a table; the round ＋ under / beside it | |
| ☐ | Drag a table by its name chip; drop on a sheet tab to move it there | | |
| ☐ | Right-click: add row/column, rename, delete records, move to sheet, remove table | | |

## Data

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | SQL over tables (SQLite), joins across workbooks | SQL button | 5 |
| ☐ | SQL write-back (UPDATE/INSERT/DELETE → versioned ops) | | 5 |
| ☐ | SQL result into a new table | | 5 |
| ☐ | Tables ⇄ JSON | `cm json Tasks`, `cm put` | |
| ☐ | Several workbooks + text notes | `+` in the top bar | 1 |
| ☐ | Export a sheet as Markdown / HTML | `cm export Robot md` | 22 |

## Charts, KPIs, lights, visuals

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Column, bar, line, area, pie charts from ranges or tables; live data | 📊 | 6 |
| ☐ | KPI cards; two figures on one KPI | 📊 on one cell; `--value2` | 6 |
| ☐ | Traffic lights (conditional formatting), formula thresholds, follow moves | 🚦 | 7 |
| ☐ | SVG visuals: lamp, switch, gauge, battery, ring, traffic, status, weather | 🎨 → Card / In cells | 8 |
| ☐ | `=VIZ("pack", value)` in cells (value still usable in formulas/SQL) | | 8 |
| ☐ | Install a model-made pack; errors explained; copy-ready prompt | 🎨 → Install a pack | 8 |
| ☐ | Hostile packs are sanitized (no scripts, no external loads, styles isolated) | e2e covers it | |

## Versioning & collaboration

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Every edit versioned; History panel reads like the agent's feed | History | 3 |
| ☐ | Milestones (Ctrl+S), move-aware diff highlighted in the grid, restore | ⚑ Milestone, History → diff | 10 |
| ☐ | Cell and table history (follows moves and inserts) | right-click → History of… | 9 |
| ☐ | Several people: names/colors, their selections, tab dots, edits flash in their color | open a second browser | 20 |
| ☐ | Agent presence: purple flashes, labelled focus box, “agent:” activity line | | 2, 3 |
| ☐ | Optimistic concurrency (`expect` → 409) | API | |

## Live

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Sheet layout and Combined layout (every table/chart/KPI/visual) | ▶ Live; Sheet / ✦ Combined | 11 |
| ☐ | 13 shader themes, fonts | ◐ Look › → theme swatch, Aa | 14 |
| ☐ | Card looks: glass / outline / clear; table lines rows / grid / none; per-card overrides (agent) | ◐ Look › → ▢ and ☰; `cm style` | 13 |
| ☐ | Adaptive ink: dark text on bright backgrounds, per card | slide with a bright image | 16 |
| ☐ | Edit values in Live (structure locked) | click a table cell or a stat | |
| ☐ | Drag to rearrange, resize, small square tiles (mouse and touch) | drag a card; corner handle | |
| ☐ | Focus a card full-screen | ⤢ on a card | 15 |
| ☐ | Flip a card to its sheet side (addresses, formulas, history) | ⟲ on a card | |
| ☐ | Relation lines between tables (and table → chart) | ⛓ | 15 |
| ☐ | Change effects: morph, scramble, vapor rows, glow | ◐ Look › → ⟡ | 12 |
| ☐ | Agent panels, reserved space (logo) | `cm panel`, ＋ Space | 15 |
| ☐ | Horizontal / vertical flow, reveal on scroll | ↕, ✨ | |
| ☐ | Phone layout | open on a phone | |
| ☐ | Slow devices: background quality steps down, `?quality=` | `/?live=Dashboard&quality=low` | |
| ☐ | Two-page bar: navigation, and ◐ Look › | | |

## Maps

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Map card from a table with coordinates (lat/lon by name, or one `coords` column) | right-click a table → 🗺 Map of …; `cm map add Places` | 18 |
| ☐ | Several tables = layers; routes; colors from traffic lights / `#hex` / values; SVG visuals at points | right-click the map → Edit chart…; `cm map layer` | 18 |
| ☐ | Grid shows a sketch of the points; Live shows the real map (OpenFreeMap; dark / light / bright / none) | | 18 |
| ☐ | Points glide when coordinates change and leave a trail | edit a Lat cell | 18 |
| ☐ | Click a point → its row; the agent focuses a point | `cm map focus Base` | 18 |
| ☐ | The agent flies the camera, follows a moving point, fits to all points | `cm map fly …`, `follow`, `fly fit` | 18 |
| ☐ | Offline: the basemap drops out, the points stay | disconnect the network | |
| ☐ | Satellite imagery (Sentinel-2) and Finnish aerial / topo / background maps (NLS, through a caching proxy) | map editor → Map; `cm config nls-key KEY` | |

## Open data from Finland

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Trains: every running train, table + map, moves every poll | `cm feed add trains --map` | 23 |
| ☐ | Ships (AIS) in an area | `cm feed add ships --map` | |
| ☐ | Road weather stations; FMI weather by place | `cm feed add roadweather --map` · `cm feed add weather --places Helsinki,Oulu` | |
| ☐ | Polls are versioned batches by “feed”: change feed, history, replay | `cm replay --from -10m` | |
| ☐ | Pause / resume / run now / remove (the table stays); `--keep` keeps vanished rows | `cm feed ls` | |

## Time replay

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Replay the last 15 min / hour / today / since a milestone / from any time | Live → ⏱ Replay | 19 |
| ☐ | Clock and date overlay; ⏩ while quiet time is squeezed | | 19 |
| ☐ | Speed ×10 … ×3600; pause (Space), previous/next change (← →), scrub the timeline | | 19 |
| ☐ | Exact past: moves, inserts, restores and map camera moves replay correctly | | 19 |
| ☐ | Editing is blocked during replay; Esc / ✕ Live returns to now | | 19 |
| ☐ | Agent and phone drive it: `cm replay --from 09:00 --speed 360`, remote ⏱ buttons | | 19 |

## Slides & remote

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | Slides from views: title, text, card filter, focus | ▤ Slides → ＋ This view | 16 |
| ☐ | Backgrounds: image, GIF, SVG, dither, halftone; drop an image on a slide | | 16 |
| ☐ | Player: keys, timer, progress, Esc | ▶ Play | 16 |
| ☐ | Screens (`/?screen=tv`) and the phone remote (`/remote`) | | 17 |
| ☐ | Remote: next/prev/play/pause, carousel of cards, edit data on the phone | | 17 |

## Agent interfaces

| ✓ | Feature | Try it | Demo |
|---|---|---|---|
| ☐ | REST API (text by default, `format=json`) | `curl :3210/api/overview` | all |
| ☐ | CLI `cm` (overview, changes, read, set, tables, SQL, charts, lights, visuals, Live, slides, screens, history) | `node bin/cm.mjs help` | all |
| ☐ | MCP server (`bin/mcp.mjs`): 15 tools incl. maps, feeds, replay and the tour | `claude mcp add spread -- node bin/mcp.mjs` | all |
| ☐ | Change feed: only what changed, moves as one line, recalculated values | `cm changes` | 3 |
| ☐ | The agent reads the screen (`cm live`) | | 11 |
