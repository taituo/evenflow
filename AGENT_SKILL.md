---
name: spread
description: Work with the user in their live Spread spreadsheet (A1 grid, formulas, named tables, SQL, charts, Live dashboards). Use when the user refers to "the sheet", a table by name, cell coordinates like C23, a dashboard, or asks what they changed.
---

# Spread — agent skill

The user has a full-screen spreadsheet open in a browser. You both edit the same workbook; every edit is versioned.
Read **only what changed**, write **small, precise** edits, and prefer **named tables** over raw coordinates.

Server: `$CANVAS_URL` (default `http://127.0.0.1:3210`). CLI: `bin/cm.mjs` (alias `cm`). Output is compact text.

## The loop

1. First contact: `cm overview` — workbooks, sheets, used ranges, named tables (with columns), charts, the user's selection.
2. Before every reply: `cm changes` — only edits since your last call; your own are filtered out; the cursor is kept in
   `~/.spread-cursor`. After a long gap use `cm changes --net` (net effect per cell).
3. Read narrowly: `cm read @Tasks` (a table as records) or `cm read Budget!A1:E6`. Never dump whole sheets "just in case".
4. Write. Every write echoes what changed and which formulas recalculated.

## Reading the change feed

```
v14 user 14:02:11 [main]
  Project!C8: open → done   ⟨Tasks[Wire the servos].Status⟩     # direct edit, with its table/record/column
  calc: Project!C12 3→2 · Dashboard!C28 3→2                     # formulas whose VALUE changed as a consequence
v15 user 14:02:30 [main]
  MOVE Budget!A2:E5 → A8:E11 (20 cells; refs updated in Budget!D6)
```
- A MOVE is one line. The data now lives at the new address; formulas pointing at it were rewritten (Sheets
  cut/paste semantics). Don't "fix" them.
- `INSERT rows 3` / `DELETE cols C:D` shift addresses below / right. Re-resolve addresses you remember.
- `∅` = empty. In `cm read`, `⇒` is a formula's computed value.

## Named tables (prefer these)

Tables are named rectangles anywhere in a sheet: first row = column names, the rest = records.
```
cm read @Tasks                                   # [7] Task: Build the chassis · Status: done · Owner: Sam
cm add Tasks '{"Task":"Test the battery","Status":"open","Owner":"Sam"}'
cm update Tasks 'Wire the servos' Status=done     # key = first-column value
cm update Tasks 'Owner=Alex' Status=done          # or match on a column (all matches)
cm rm Tasks 'Status=done'                         # removes records inside the table only
cm addcol Tasks Priority
cm mktable Ideas B16:C18                          # name an existing block (header row first)
```
Formulas: `=COUNTIF(Tasks[Status],"open")`, `=SUM(Parts[Price])`, `Tasks[#All]`.

## Cells, ranges, structure

```
cm set C1=Status 'D5==B5*C5' 'Settings!B1=300'     # value or =formula; quote anything with ! or spaces
cm table H1 '[["Category","Total"],["Servos","=SUM(D2:D3)"]]'
cm move C23:D32 F23                                # cut/paste — references follow
cm insert-rows 5 2 --sheet=Budget | cm delete-cols C 1
cm fmt A1:E1 '{"b":true,"fill":"#fff2cc","fs":16,"ff":"serif"}'   # b i u s fill color align valign fs ff wrap
cm border B6:E11 outer thick '#1a73e8'             # all|inner|horizontal|vertical|outer|left|top|right|bottom|clear
cm merge B2:E2 | cm unmerge B2:E2
cm note B7 "Is this the 2025 price?"               # ask the user something *in the cell*
cm traffic Budget!D2:D5 '<20:green' 'between 20 60:amber' '>60:red'   # traffic lights (also '=done:green', ':#hex', 'off')
cm image B2 photo.png                              # =IMAGE("/assets/…")
cm focus B2:B9 "checking quantities"               # purple box on the user's grid while you work
```
Raw atomic batch: `POST /api/ops {"by":"agent","ops":[…],"expect":{"Budget!B2":"4"}}` — with `expect` you get **409** and
the current value instead of overwriting something the user just changed.

## SQL (both directions) and JSON

Every named table is a SQL table (Node's built-in SQLite). Tables in other workbooks: `"doc.Table"`.
```
cm sql "SELECT Owner, COUNT(*) n FROM Tasks WHERE Status='open' GROUP BY Owner"
cm sql "SELECT t.Task, p.Price FROM Tasks t JOIN Parts p ON t.Notes LIKE '%' || p.Part || '%'"
cm sql --write "UPDATE Tasks SET Status='done' WHERE Owner='Alex'"   # → table ops (versioned, undoable)
cm sql --into Summary@Dashboard!B30 "SELECT Status, COUNT(*) n FROM Tasks GROUP BY Status"
cm json Tasks | cm put Tasks rows.json [Sheet!B2]
```

## Charts and documents

```
cm chart column B6:C10 --at K2 --title "Prices"        # column | bar | line | area | pie | kpi
cm chart pie @StatusMix --title "Task status"           # table source (--x label column, --y value columns)
cm chart kpi Project!C12 --title "Open tasks" --at B5 [--size small] [--value2 C13 --label2 cost]   # square tile / two figures
cm chart-show status | cm chart-set status type=bar w=500 | cm chart-rm status
cm export Dashboard md                                   # sheet → document (headings, tables, charts, KPIs)
```

## Live mode — the user's dashboard screen

The user can turn any sheet into **Live**: a full-screen, real-time presentation over a shader background. Your writes
animate there. Two layouts: **sheet** (the grid's own layout) and **combined** (every table, chart and KPI of the
workbook, auto-composed, user-arrangeable).
```
cm live                                   # what the screen shows right now: cards, positions, what is visible
cm present Dashboard --combined           # open Live on the user's screen
cm present Dashboard chart:status         # focus one view full-screen (keys: chart:<id>, table:<name>, stat:<cell>)
cm present off
cm panel add brief "Agent summary" "**3 tasks open.**\n- Next: wire the servos" [--value 42 --label EUR --span 2]
cm panel rm brief
cm slot logo --image /assets/logo.png --span 1 --h 160   # reserve space (the user can drag it anywhere)
cm layout '{"flow":"horizontal"}'         # also: order, spans, hidden, reveal
cm ops '[{"op":"view","sheet":"Dashboard","theme":"ocean","font":"rounded"}]'
```
Slides (a presentation made of Live views — build them when the user asks for a deck / a show):
```
cm slides
cm slide add intro '{"title":"Week 42","text":"**3 open** tasks","cards":[]}'          # cards: [] = title slide
cm slide add kpis '{"title":"Costs","sheet":"Dashboard","mode":"auto","cards":["kpiCost","parts"],"duration":8}'
cm slide add hero '{"title":"Robot","bg":{"image":"/assets/robot.gif"},"cards":[]}'      # image / GIF / SVG background
#   bg.filter: "dither" | "halftone" runs the image through a shader;  bg.theme picks a shader theme instead
cm slide rm kpis
cm present --slide 1                          # play on the user's screen (only when asked)
```
Card ids for `cards`/`focus`: chart ids, table names, `stat:A1`, panel ids. Live text adapts to the background
(dark text on bright images) automatically — you don't pick colors.

Remote control — every open Live view is a *screen* (a TV at `/?screen=tv`, the user's laptop…):
```
cm screens                                 # which screens exist and what each shows
cm present next --screen tv                # next slide — or, with no slides, next card (carousel)
cm present toggle|play|pause|prev|unfocus [--screen tv]
cm live                                    # what the (most recent) screen shows; GET /api/live?screen=tv
```
Change effects (what values do on screen when data changes): `cm layout '{"fx":"scramble"}'` — morph (default),
scramble, vapor, glow, none. Your edits animate: keep batches meaningful.

Themes: aurora nebula ocean ember forest ink grain neuro warp smoke rays swirl blobs. Fonts: display sans serif mono
rounded condensed geometric hand. For a sheet-layout dashboard, put titles in big-font cells and charts/KPIs where they
should appear; hide gridlines with `{"op":"view","sheet":"Dashboard","grid":false}`.

## People and history

Several humans may be connected. `cm people` shows who is where (sheet, selection, Live/slide). The change feed shows
`by user (Name)`. Before changing a cell that someone else is editing right now, prefer a `note`.
```
cm history Project!C8        # every change to that cell, following moves and row inserts
cm history @Tasks            # every change inside a table, plus its structural changes
```
Use history to answer "who changed this / what was it before" instead of guessing.

## Voice and coordinates

The user may speak: *"add C23 and D32"*. Coordinates are A1; the sheet prefix is optional (`Settings!B1`; quote names
with spaces: `'My data'!A1`). If they don't say where the result goes, write to their **active cell** (`cm sel`) — or the
first empty cell below it — and say the address out loud. "This / these / the selected ones" = `cm sel`.

## Formulas

Operators `+ - * / ^ & % = <> < > <= >=`; refs `A1 $A$1 A1:B9 A:A 2:2 Sheet!A1 Table[Column]`; separators `,` or `;`.
SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT SUMIF COUNTIF AVERAGEIF IF IFS IFERROR AND OR NOT XOR
ISBLANK ISNUMBER ISTEXT ISERROR ROUND ROUNDUP ROUNDDOWN INT ABS SQRT POWER MOD LEN UPPER LOWER TRIM LEFT RIGHT
MID EXACT CONCAT CONCATENATE TEXTJOIN VLOOKUP MATCH INDEX ROWS COLUMNS PI NA IMAGE HYPERLINK.
Errors: `#REF! #DIV/0! #NAME? #VALUE! #N/A #CYCLE! #ERROR!`. Checks/validation = `IF(…,"ok","✗ …")` columns.

## Milestones

`cm commit "message"` saves a named snapshot. `cm diff last` (or `m3`) shows what changed since — move-aware.
`cm restore m3` reverts (only when asked). The user saves milestones too (Ctrl+S).

## Etiquette

- Add, don't overwrite: new columns, tables or sheets unless asked to change the user's cells.
- Keep batches small and meaningful — each one flashes on the user's screen.
- Never rewrite formulas the user wrote unless asked; leave a `note` instead.
- In Live, don't hijack the screen: use `cm present` only when the user asks or clearly expects it.

## HTTP reference (text by default, `&format=json` for JSON)

| | |
|---|---|
| `GET /api/overview` | docs, sheets, used ranges, tables, charts, selection |
| `GET /api/changes?since=N[&exclude=agent][&mode=net][&doc=]` | change feed; last line `cursor: N` |
| `GET /api/read?range=Sheet!A1:F20[&doc=]` | non-empty cells (`Sheet!` alone = used range, `@Table` = records) |
| `GET /api/find?q=text` | cells containing text |
| `GET /api/selection` | the user's current selection |
| `POST /api/ops` | `{doc?, by, ops:[…], expect?}` → version + changes (`?format=text`) |
| `POST /api/sql` | `{sql, write?, into?:{name,at}}` |
| `GET /api/table?name=` · `PUT /api/table {name, rows, at?}` | table ⇄ JSON |
| `GET /api/chart?id=` | chart data |
| `GET /api/export?sheet=&format=md\|html\|json` | sheet as a document |
| `POST /api/assets` (raw image body) | → `{url}` for `=IMAGE(url)` |
| `POST /api/commit {message}` · `GET /api/commits` · `GET /api/diff?from=m3` · `POST /api/restore {commit}` | milestones |
| `POST /api/focus {range, label}` | highlight where you work |
| `POST /api/present {sheet, mode?, focus?, slide?, action?, screen?, off?}` · `GET /api/live[?screen=]` · `GET /api/screens` | drive Live / slides / remote actions · read what a screen shows |
| `POST /api/docs {type:"sheet"\|"text", title}` | new workbook / notes |
| `GET /api/history?cell=Sheet!C8` · `?table=Tasks` | change history (move-aware) |
| `GET /api/presence` | who is connected and where |
| `GET /api/events` | SSE stream of every batch |

Ops: `set {cells}|{range,values}` · `move {from,to}` · `insertRows|deleteRows {at,count}` · `insertCols|deleteCols {at:"C",count}` ·
`format {range|ranges,style}` · `borders {range|ranges,type,style,color}` · `merge {range,type}` · `unmerge {range}` ·
`note {cell,text}` · `resize {cols:{A:140},rows:{"3":40}}` · `freeze {rows,cols}` · `view {sheet,grid?,theme?,font?}` ·
`addSheet {name}` · `renameSheet {sheet,name}` · `deleteSheet {sheet}` ·
tables: `table {name,range}` · `deleteTable` · `renameTable {name,newName}` · `appendRows {table,rows}` ·
`updateRows {table, key|match|rows, set}` · `removeRows {table, key|match|rows}` · `addColumn {table,name,values?}` ·
charts: `addChart {type, range|table(+x,y)|value, title, at, dx, dy, w, h}` · `updateChart {id,…}` · `deleteChart {id}` ·
traffic lights: `cond {range, rules:[{when, value, value2?, light|style}], id?}` · `removeCond {id | range}` ·
live: `liveLayout {order, spans (span 0.5 = small tile), hidden, flow, reveal, slots, links, fx}` · `panel {id, title, text, value, label, image, span, h}` · `removePanel {id}` ·
`slide {id, index?, title, text, sheet, mode, focus, cards, bg:{image, filter, theme}, duration}` · `removeSlide {id}`.
Text docs: `setText {text}` · `append {text}`. Every sheet op takes an optional `sheet`; cell keys may carry a sheet prefix.
