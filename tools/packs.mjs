#!/usr/bin/env node
// Generates the telemetry visual packs in public/viz/ (spread-viz/1). One design language: thin big numerals,
// gradient arcs with a soft glow, uppercase captions, cold → optimal → hot colors from data-level.
//   node tools/packs.mjs        (then the packs are plain JSON files; nothing here runs at runtime)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack } from '../public/shared/viz.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'viz');
const F = `font-family:'SF Pro Display',Inter,'Segoe UI',system-ui,sans-serif`;
const r2 = (n) => +n.toFixed(2);
/** point on a circle; angle in degrees clockwise from 12 o'clock */
const pt = (cx, cy, r, a) => [r2(cx + r * Math.sin((a * Math.PI) / 180)), r2(cy - r * Math.cos((a * Math.PI) / 180))];
const arc = (cx, cy, r, a0, a1) => { const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1); return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
/** CSS that colors `sel` by the 11 levels of `attr` (data-level or data-<input>) */
const levels = (attr, sel, prop, colors) => colors.map((c, i) => `[${attr}="${i}"] ${sel}{${prop}:${c}}`).join('');
const TEMP = ['#2563eb', '#2f7cf6', '#22a6f2', '#14b8a6', '#22c55e', '#22c55e', '#84cc16', '#facc15', '#fb923c', '#f97316', '#ef4444'];
const HEALTH = ['#ef4444', '#ef4444', '#f97316', '#fb923c', '#facc15', '#facc15', '#a3e635', '#4ade80', '#22c55e', '#22c55e', '#22c55e'];
const HEAT = ['#3a3f4b', '#4a3f45', '#6b3a2c', '#8f3a1c', '#b8461a', '#d9541a', '#f26a1b', '#ff8a2a', '#ffad42', '#ffd36b', '#fff1b8'];
const cap = (x, y, size = 12, extra = '') => `<text x="${x}" y="${y}" text-anchor="middle" class="cap" style="font-size:${size}px${extra}">{{label}}</text>`;
const base = `.cap{${F};font-weight:600;letter-spacing:.12em;text-transform:uppercase;fill:currentColor;opacity:.7}.num{${F};font-weight:200;fill:currentColor;font-variant-numeric:tabular-nums}.trk{fill:none;stroke:currentColor;stroke-opacity:.12}`;
const svg = (vb, style, body) => `<svg viewBox="${vb}"><style>${base}${style}</style>${body}</svg>`;
const glow = (id, sd = 3) => `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;

const packs = [];
const add = (p) => packs.push({ spec: 'spread-viz/1', author: 'Spread', ...p });

// ------------------------------------------------------------------ arc: a big number inside a gradient arc (engine temp)
{
  const A = arc(100, 98, 76, -135, 135);
  add({ id: 'arc', kind: 'range', name: 'Arc gauge', description: 'A big number in a 270° gradient arc. Set the scale where you use it: =VIZ("arc", A1, "Engine °C", 0, 150)', min: 0, max: 150,
    svg: svg('0 0 200 190', `.val{fill:none;stroke:url(#ag);stroke-width:9;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100)}.halo{fill:none;stroke:url(#ag);stroke-width:16;opacity:.35;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100)}.big{font-size:58px;fill:url(#tg)}`,
      `<defs><linearGradient id="ag" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#5b2cff"/><stop offset=".55" stop-color="#e0245e"/><stop offset="1" stop-color="#ff4d2e"/></linearGradient><linearGradient id="tg" x1="0" x2="1"><stop offset="0" stop-color="#ff5470"/><stop offset="1" stop-color="#ff3b30"/></linearGradient>${glow('ab', 5)}</defs>
<path class="trk" d="${A}" stroke-width="9" stroke-linecap="round" pathLength="100"/><path class="halo" d="${A}" pathLength="100" filter="url(#ab)"/><path class="val" d="${A}" pathLength="100"/>
<text x="100" y="118" text-anchor="middle" class="num big">{{value}}</text>${cap(100, 168, 11)}`) });
}

// ------------------------------------------------------------------ dial: ticks and a redline (RPM)
{
  const ticks = [];
  for (let i = 0; i <= 40; i++) {
    const a = -120 + (240 * i) / 40, major = i % 5 === 0, red = i >= 34;
    const [x0, y0] = pt(100, 100, major ? 66 : 70, a), [x1, y1] = pt(100, 100, 77, a);
    ticks.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="${red ? 'tk rd' : 'tk'}${major ? ' mj' : ''}"/>`);
  }
  const A = arc(100, 100, 86, -120, 120);
  add({ id: 'dial', kind: 'range', name: 'Dial', description: 'A tachometer: ticks, a redline, a sweeping gradient arc and the value in the middle (RPM ×1000, speed…).', min: 0, max: 18,
    svg: svg('0 0 200 185', `.tk{stroke:currentColor;stroke-opacity:.45;stroke-width:1.2}.mj{stroke-opacity:.9;stroke-width:2.2}.rd{stroke:#ff3b30;stroke-opacity:1}.val{fill:none;stroke:url(#dg);stroke-width:6;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100)}.big{font-size:56px}[data-level="9"] .big,[data-level="10"] .big{fill:#ff4d3a}`,
      `<defs><linearGradient id="dg" x1="0" x2="1"><stop offset="0" stop-color="#3b5bff"/><stop offset=".6" stop-color="#b03cff"/><stop offset="1" stop-color="#ff2d55"/></linearGradient></defs>
<path class="trk" d="${A}" stroke-width="6" stroke-linecap="round" pathLength="100"/><path class="val" d="${A}" pathLength="100"/>${ticks.join('')}
<text x="100" y="118" text-anchor="middle" class="num big">{{value}}</text>${cap(100, 168, 11)}`) });
}

// ------------------------------------------------------------------ segments: a dashed ring that fills (boost, charge)
{
  const A = arc(100, 98, 72, -135, 135);
  add({ id: 'segments', kind: 'range', name: 'Segment ring', description: 'A 270° ring of segments that light up with the value (boost, charge, level).', min: 0, max: 20,
    svg: svg('0 0 200 190', `.seg{fill:none;stroke-width:12;stroke-dasharray:3.2 1.4}.off{stroke:currentColor;stroke-opacity:.14}.on{stroke:url(#sg)}.m{fill:none;stroke:#fff;stroke-width:16;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100)}.big{font-size:58px;fill:#ffb020}[data-level="9"] .big,[data-level="10"] .big{fill:#ff6a2a}`,
      `<defs><linearGradient id="sg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ffd23f"/></linearGradient><mask id="sm"><path class="m" d="${A}" pathLength="100"/></mask></defs>
<path class="seg off" d="${A}" pathLength="100"/><path class="seg on" d="${A}" pathLength="100" mask="url(#sm)"/>
<text x="100" y="118" text-anchor="middle" class="num big">{{value}}</text>${cap(100, 168, 11)}`) });
}

// ------------------------------------------------------------------ pills: a row of pills (pressure in bars, signal)
{
  const pills = Array.from({ length: 6 }, (_, i) => `<rect x="${4 + i * 26}" y="10" width="22" height="12" rx="6"/>`).join('');
  add({ id: 'pills', kind: 'range', name: 'Pills', description: 'Six pills that fill from the left, the value beside them (bars of pressure, signal, stock).', min: 0, max: 6,
    svg: svg('0 0 240 52', `.off rect{fill:currentColor;fill-opacity:.14}.on rect{fill:#3b82f6}.mk{fill:#fff;transform-box:fill-box;transform-origin:left center;transform:scaleX(var(--v))}.big{font-size:26px;fill:#3b82f6}.cap{text-anchor:start}`,
      `<defs><mask id="pm"><rect class="mk" x="0" y="0" width="160" height="40"/></mask></defs><g class="off">${pills}</g><g class="on" mask="url(#pm)">${pills}</g>
<text x="176" y="27" class="num big">{{value}}</text><text x="4" y="46" class="cap" style="font-size:11px">{{label}}</text>`) });
}

// ------------------------------------------------------------------ bar: a gradient bar (coolant, fuel, progress)
add({ id: 'bar', kind: 'range', name: 'Gradient bar', description: 'A rounded bar with a cool-to-hot gradient, the value at its end and a caption below.', min: 0, max: 100,
  svg: svg('0 0 240 52', `.f{fill:url(#bg);transform-box:fill-box;transform-origin:left center;transform:scaleX(var(--v))}.big{font-size:26px;fill:#ff8a2a}[data-level="0"] .big,[data-level="1"] .big,[data-level="2"] .big,[data-level="3"] .big{fill:#3b82f6}.cap{text-anchor:start}`,
    `<defs><linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="4" y1="0" x2="164" y2="0"><stop offset="0" stop-color="#2f6bff"/><stop offset=".5" stop-color="#9b3cff"/><stop offset=".8" stop-color="#ff3b5c"/><stop offset="1" stop-color="#ff9a2a"/></linearGradient><clipPath id="bc"><rect x="4" y="11" width="160" height="10" rx="5"/></clipPath></defs>
<rect x="4" y="11" width="160" height="10" rx="5" fill="currentColor" fill-opacity=".14"/><g clip-path="url(#bc)"><rect class="f" x="4" y="11" width="160" height="10"/></g>
<text x="176" y="27" class="num big">{{value}}</text><text x="4" y="46" class="cap" style="font-size:11px">{{label}}</text>`) });

// ------------------------------------------------------------------ vital: a ring with a knob at the end (heart rate, any vital)
{
  add({ id: 'vital', kind: 'range', name: 'Vital ring', description: 'A ring with a glowing knob at the value, the number inside and a unit (the label) below it — heart rate, breaths, any vital sign.', min: 40, max: 200,
    svg: svg('0 0 120 120', `.val{fill:none;stroke:url(#vg);stroke-width:5;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100);transform:rotate(-90deg);transform-origin:60px 60px}.kn{transform-origin:60px 60px;transform:rotate(calc(var(--v) * 360deg))}.big{font-size:30px}.u{${F};font-size:10px;font-weight:600;letter-spacing:.1em;fill:currentColor;opacity:.75}`,
      `<defs><linearGradient id="vg" x1="0" x2="1"><stop offset="0" stop-color="#1f6bff"/><stop offset="1" stop-color="#55b6ff"/></linearGradient>${glow('vb', 2.5)}</defs>
<circle class="trk" cx="60" cy="60" r="46" stroke-width="5"/><circle class="val" cx="60" cy="60" r="46" pathLength="100"/>
<g class="kn"><circle cx="60" cy="14" r="6" fill="#55b6ff" filter="url(#vb)"/><circle cx="60" cy="14" r="4" fill="#0b1630" stroke="#55b6ff" stroke-width="2"/></g>
<text x="60" y="64" text-anchor="middle" class="num big">{{value}}</text><text x="60" y="80" text-anchor="middle" class="u">{{label}}</text>`) });
}

// ------------------------------------------------------------------ dots: a dotted ring (stress, load)
add({ id: 'dots', kind: 'range', name: 'Dotted ring', description: 'A ring of dots that light up with the value; the number inside (stress, load, readiness).', min: 0, max: 100,
  svg: svg('0 0 120 120', `.d{fill:none;stroke-width:5;stroke-linecap:round;stroke-dasharray:0 4.2;transform:rotate(-90deg);transform-origin:60px 60px}.off{stroke:currentColor;stroke-opacity:.18}.on{stroke:#4f8bff}.m{fill:none;stroke:#fff;stroke-width:10;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100);transform:rotate(-90deg);transform-origin:60px 60px}.big{font-size:32px}${levels('data-level', '.on', 'stroke', ['#4f8bff', '#4f8bff', '#4f8bff', '#4f8bff', '#4f8bff', '#8b7bff', '#b06bff', '#e0569a', '#ff5a5a', '#ff3b30', '#ff3b30'])}`,
    `<defs><mask id="dm"><circle class="m" cx="60" cy="60" r="44" pathLength="100"/></mask></defs><circle class="d off" cx="60" cy="60" r="44" pathLength="100"/><circle class="d on" cx="60" cy="60" r="44" pathLength="100" mask="url(#dm)"/>
<text x="60" y="71" text-anchor="middle" class="num big">{{value}}</text>`) });

// ------------------------------------------------------------------ life: a percentage ring, red → green (tyre life, battery, health)
add({ id: 'life', kind: 'range', name: 'Life ring', description: 'A percentage ring colored by how much is left: red, orange, yellow, green (tyre life, battery, health).', min: 0, max: 100,
  svg: svg('0 0 120 120', `.val{fill:none;stroke-width:6;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--v)) * 100);transform:rotate(-90deg);transform-origin:60px 60px}.big{font-size:30px}.pc{font-size:15px}${levels('data-level', '.val', 'stroke', HEALTH)}`,
    `<circle class="trk" cx="60" cy="60" r="44" stroke-width="6"/><circle class="val" cx="60" cy="60" r="44" pathLength="100"/>
<text x="60" y="70" text-anchor="middle" class="num big">{{pct}}<tspan class="pc" dx="1">%</tspan></text>`) });

// ------------------------------------------------------------------ tyre: one tyre, top view, colored by temperature
add({ id: 'tyre', kind: 'range', name: 'Tyre', description: 'A tyre seen from above, colored by temperature: blue cold, green in the window, yellow → red hot.', min: 60, max: 130,
  svg: svg('0 0 60 100', `.t{transition:fill .6s}${levels('data-level', '.t', 'fill', TEMP)}.g{stroke:#000;stroke-opacity:.25;stroke-width:2.2}`,
    `<defs><linearGradient id="ts" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset=".35" stop-color="#fff" stop-opacity=".22"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient></defs>
<rect class="t" x="6" y="4" width="48" height="92" rx="12"/><path class="g" d="M20 10V90M30 8V92M40 10V90"/><rect x="6" y="4" width="48" height="92" rx="12" fill="url(#ts)"/>`) });

// ------------------------------------------------------------------ brake: a disc that glows with temperature, and the reading
{
  const holes = Array.from({ length: 12 }, (_, i) => { const [x, y] = pt(50, 55, 30, i * 30); return `<circle cx="${x}" cy="${y}" r="2.2"/>`; }).join('');
  add({ id: 'brake', kind: 'range', name: 'Brake disc', description: 'A brake disc that heats from dark grey through orange to white-hot, glowing, with the reading beside it (°C).', min: 100, max: 1100,
    svg: svg('0 0 230 110', `.dk{transition:fill .6s}${levels('data-level', '.dk', 'fill', HEAT)}.gl{opacity:calc(var(--v) * 1.1 - .15);transition:opacity .6s}${levels('data-level', '.gl', 'fill', HEAT)}${levels('data-level', '.ky', 'fill', HEAT)}.h{fill:#000;fill-opacity:.45}.k{${F};font-size:12px;fill:currentColor;opacity:.75}.n{font-size:34px}.u{font-size:16px;opacity:.8}`,
      `<defs>${glow('bb', 7)}</defs><circle class="gl" cx="50" cy="55" r="40" filter="url(#bb)"/><circle class="dk" cx="50" cy="55" r="38"/><circle cx="50" cy="55" r="38" fill="none" stroke="#000" stroke-opacity=".3" stroke-width="2"/><g class="h">${holes}</g><circle cx="50" cy="55" r="17" fill="#22252c"/><circle cx="50" cy="55" r="7" fill="#0d0f13"/>
<rect class="ky" x="108" y="30" width="10" height="10" rx="2"/><text x="124" y="40" class="k">{{label}}</text><text x="106" y="82" class="num n">{{value}}<tspan class="u" dx="3">°c</tspan></text>`) });
}

// ------------------------------------------------------------------ tyre-panel: temp + pressure + life for one corner
add({ id: 'tyre-panel', kind: 'multi', name: 'Tyre panel', description: 'One wheel: temperature and pressure with colored keys, and the tyre life ring. =VIZ("tyre-panel", B2:D2, "FL tire").',
  inputs: [{ id: 'temp', label: 'Temp °C', min: 60, max: 130 }, { id: 'psi', label: 'Pressure psi', min: 15, max: 30 }, { id: 'life', label: 'Life %', min: 0, max: 100 }],
  svg: svg('0 0 220 200', `.h{${F};font-size:14px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;fill:currentColor}.k{${F};font-size:11px;fill:currentColor;opacity:.7}.n{font-size:26px}.u{font-size:13px;opacity:.75}.ln{stroke:currentColor;stroke-opacity:.18}${levels('data-temp', '.kt', 'fill', TEMP)}${levels('data-psi', '.kp', 'fill', ['#3b82f6', '#3b82f6', '#22a6f2', '#22c55e', '#22c55e', '#22c55e', '#22c55e', '#84cc16', '#facc15', '#fb923c', '#ef4444'])}.lf{fill:none;stroke-width:6;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:calc((1 - var(--life)) * 100);transform:rotate(-90deg);transform-origin:110px 148px}${levels('data-life', '.lf', 'stroke', HEALTH)}`,
    `<text x="10" y="20" class="h">{{label}}</text><line x1="10" y1="30" x2="210" y2="30" class="ln"/>
<rect x="10" y="42" width="9" height="9" rx="1.5" class="kt"/><text x="25" y="51" class="k">Temp</text><rect x="118" y="42" width="9" height="9" rx="1.5" class="kp"/><text x="133" y="51" class="k">Pressure</text>
<text x="10" y="84" class="num n">{{temp}}<tspan class="u" dx="2">°c</tspan></text><text x="118" y="84" class="num n">{{psi}}<tspan class="u" dx="4">psi</tspan></text>
<text x="110" y="106" text-anchor="middle" class="k">Life</text><circle class="trk" cx="110" cy="148" r="34" stroke-width="6"/><circle class="lf" cx="110" cy="148" r="34" pathLength="100"/>
<text x="110" y="157" text-anchor="middle" class="num" style="font-size:24px">{{life}}<tspan style="font-size:13px">%</tspan></text>`) });

// ------------------------------------------------------------------ car: an open-wheel race car from above (original design)
{
  // slick tyres (no grooves, like modern race slicks): temperature color, sidewall shading, a hub cover on the inner side
  const tyre = (k, x, y, w, h, inner) => `<g class="ty ${k}"><rect class="tc" x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.3}"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.3}" fill="url(#tsh)"/><rect x="${inner ? x + w - 7 : x + 1}" y="${y + h * 0.28}" width="6" height="${h * 0.44}" rx="2" fill="#0b0c0f" opacity=".85"/></g>`;
  const brake = (k, cx, cy) => `<ellipse class="bk ${k}" cx="${cx}" cy="${cy}" rx="10" ry="16" filter="url(#bgl)"/>`;
  const arm = (x1, y1, x2, y2) => `<path d="M${x1} ${y1}L${x2} ${y2}" class="arm"/>`;
  const body = `
<!-- floor and sidepods -->
<path class="fl" d="M78 168Q50 176 46 206L42 300Q44 336 76 346L144 346Q176 336 178 300L174 206Q170 176 142 168Z"/>
<path class="lv" d="M82 176Q62 184 58 210L56 286Q60 316 86 324L134 324Q160 316 164 286L162 210Q158 184 138 176Z"/>
<path d="M82 176Q62 184 58 210L56 286Q60 316 86 324L134 324Q160 316 164 286L162 210Q158 184 138 176Z" fill="url(#bsh)"/>
<path class="ink" d="M66 214Q62 200 80 190M154 214Q158 200 140 190" />
<path class="ac" d="M60 250Q64 300 92 318L96 312Q72 296 68 250Z" opacity=".55"/><path class="ac" d="M160 250Q156 300 128 318L124 312Q148 296 152 250Z" opacity=".55"/>
<!-- suspension -->
${arm(98, 112, 50, 104)}${arm(98, 126, 50, 116)}${arm(122, 112, 170, 104)}${arm(122, 126, 170, 116)}
${arm(92, 330, 50, 356)}${arm(92, 344, 50, 368)}${arm(128, 330, 170, 356)}${arm(128, 344, 170, 368)}
<!-- nose and chassis -->
<path class="lv" d="M104 46Q110 36 116 46L126 158Q128 176 124 196H96Q92 176 94 158Z"/>
<path d="M104 46Q110 36 116 46L126 158Q128 176 124 196H96Q92 176 94 158Z" fill="url(#nsh)"/>
<path class="ac" d="M108 50h4l3 104h-10z" opacity=".9"/>
<!-- cockpit, driver, halo -->
<path d="M94 196Q110 186 126 196L128 238Q110 246 92 238Z" fill="#0c0d11"/>
<circle cx="110" cy="222" r="10.5" class="hm"/><path d="M101 218q9-7 18 0v5q-9 3-18 0z" fill="#101218"/><path d="M103 214q7-6 14 0" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.5"/>
<path d="M92 206Q110 182 128 206" fill="none" stroke="#2c2f37" stroke-width="5" stroke-linecap="round"/><path d="M110 188v14" stroke="#2c2f37" stroke-width="4.5" stroke-linecap="round"/>
<!-- airbox, engine cover, fin -->
<path d="M100 240h20l-2 18h-16z" fill="#14151a"/>
<path class="lv" d="M96 256Q110 250 124 256L120 336Q110 342 100 336Z"/>
<path d="M96 256Q110 250 124 256L120 336Q110 342 100 336Z" fill="url(#nsh)"/>
<path d="M110 248v92" stroke="#0e0f13" stroke-width="2.5"/>
<text x="110" y="304" text-anchor="middle" class="no">{{label}}</text>
<!-- rear wing with DRS flap -->
<path class="cb" d="M38 388h144v12H38z"/><path class="lv" d="M38 386h144v4H38z"/><path class="cb" d="M42 402h136v8H42z" opacity=".9"/>
<path class="cb" d="M34 380h7v36h-7zM179 380h7v36h-7z"/>
<path class="cb" d="M100 346h20l4 40h-28z"/>
<!-- front wing: three elements, endplates -->
<path class="cb" d="M14 44Q110 26 206 44L206 52Q110 36 14 52Z"/>
<path class="lv" d="M16 54Q110 38 204 54L204 59Q110 44 16 59Z"/>
<path class="cb" d="M18 61Q110 47 202 61L202 66Q110 53 18 66Z" opacity=".9"/>
<path class="cb" d="M10 34h7v38h-7zM203 34h7v38h-7z"/>
<path class="ac" d="M12 34h3v38h-3zM205 34h3v38h-3z" opacity=".5"/>`;
  add({ id: 'car', kind: 'multi', name: 'Race car (top view)', description: 'An open-wheel car seen from above: each tyre colored by its temperature, brakes glowing with theirs, livery in any color, the car number on the engine cover. =VIZ("car", B2:J2, "44") — fl fr rl rr (tyre °C), flb frb rlb rrb (brake °C), color (#hex).',
    inputs: [{ id: 'fl', label: 'FL tyre °C', min: 60, max: 130 }, { id: 'fr', label: 'FR tyre °C', min: 60, max: 130 }, { id: 'rl', label: 'RL tyre °C', min: 60, max: 130 }, { id: 'rr', label: 'RR tyre °C', min: 60, max: 130 },
      { id: 'flb', label: 'FL brake °C', min: 100, max: 1100 }, { id: 'frb', label: 'FR brake °C', min: 100, max: 1100 }, { id: 'rlb', label: 'RL brake °C', min: 100, max: 1100 }, { id: 'rrb', label: 'RR brake °C', min: 100, max: 1100 },
      { id: 'color', type: 'color', label: 'Livery', value: '#c8102e' }],
    svg: svg('0 0 220 430', `.lv{fill:var(--color);transition:fill .6s}.cb{fill:#16171c}.fl{fill:#0f1014}.ac{fill:#fff}.ink{fill:none;stroke:#000;stroke-opacity:.35;stroke-width:2}.arm{stroke:#25272e;stroke-width:3.2;stroke-linecap:round}.hm{fill:#f2f2f2}.no{${F};font-weight:800;font-style:italic;font-size:24px;fill:#fff;letter-spacing:-.04em}.tc{transition:fill .6s}.bk{fill:#ff6a1a;transition:opacity .6s;opacity:calc(var(--flb) * 1.25 - .3)}.bk.fr{opacity:calc(var(--frb) * 1.25 - .3)}.bk.rl{opacity:calc(var(--rlb) * 1.25 - .3)}.bk.rr{opacity:calc(var(--rrb) * 1.25 - .3)}
${['fl', 'fr', 'rl', 'rr'].map((k) => levels(`data-${k}`, `.ty.${k} .tc`, 'fill', TEMP)).join('')}`,
      `<defs><linearGradient id="tsh" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".22" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity=".05"/><stop offset=".8" stop-color="#000" stop-opacity=".15"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></linearGradient>
<linearGradient id="bsh" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".25" stop-color="#000" stop-opacity=".1"/><stop offset=".45" stop-color="#fff" stop-opacity=".16"/><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient>
<linearGradient id="nsh" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset=".4" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></linearGradient>${glow('bgl', 5)}</defs>
${brake('fl', 58, 112)}${brake('fr', 162, 112)}${brake('rl', 58, 362)}${brake('rr', 162, 362)}
${tyre('fl', 20, 76, 36, 72, true)}${tyre('fr', 164, 76, 36, 72, false)}${tyre('rl', 14, 320, 44, 82, true)}${tyre('rr', 162, 320, 44, 82, false)}${body}`) });
}

// ------------------------------------------------------------------ driver: number, name, helmet in team color
add({ id: 'driver', kind: 'multi', name: 'Driver', description: 'A helmet in the team color, the big race number and the name (the label). =VIZ("driver", B2:C2, "L. Hamilton") with B2 = number, C2 = #color.',
  inputs: [{ id: 'num', label: 'Number', min: 0, max: 99 }, { id: 'color', type: 'color', label: 'Color', value: '#c8102e' }],
  svg: svg('0 0 320 150', `.hm{fill:var(--color);transition:fill .6s}.big{${F};font-weight:800;font-style:italic;font-size:92px;fill:currentColor;letter-spacing:-.04em}.nm{${F};font-weight:800;font-style:italic;font-size:24px;fill:currentColor;text-transform:uppercase}`,
    `<defs><linearGradient id="vs" x1="0" x2="1"><stop offset="0" stop-color="#0b0c10"/><stop offset=".6" stop-color="#2a2f3a"/><stop offset="1" stop-color="#0b0c10"/></linearGradient><linearGradient id="hs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<g transform="translate(6 18)"><path class="hm" d="M8 70Q8 8 66 6q48 2 52 52v26q0 18-16 22H30Q8 104 8 70z"/><path d="M8 70Q8 8 66 6q48 2 52 52v26q0 18-16 22H30Q8 104 8 70z" fill="url(#hs)"/><path d="M52 44h64v26q-30 6-64-2z" fill="url(#vs)"/><path d="M20 92h90" stroke="#fff" stroke-opacity=".7" stroke-width="4"/><path d="M14 60q10-40 54-46" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="5" stroke-linecap="round"/></g>
<text x="148" y="96" class="big">{{num}}</text><text x="150" y="132" class="nm">{{label}}</text>`) });

// ------------------------------------------------------------------ position badge: P1, P2…
{
  const frame = (bg, ring) => svg('0 0 120 100', `.p{${F};font-weight:300;font-size:48px;fill:#fff}`, `<rect x="4" y="4" width="112" height="92" rx="6" fill="${bg}"/><rect x="4" y="4" width="112" height="92" rx="6" fill="none" stroke="${ring}" stroke-width="2"/><text x="60" y="66" text-anchor="middle" class="p">P{{value}}</text>`);
  add({ id: 'position', kind: 'states', name: 'Position', description: 'P1, P2… in a badge: gold-edged for the podium.', states: [
    { id: 'first', label: 'Leader', when: '=', value: 1, svg: frame('#8e1020', '#ffd36b') },
    { id: 'podium', label: 'Podium', when: '<=', value: 3, svg: frame('#8e1020', '#d4d7de') },
    { id: 'points', label: 'Points', when: '<=', value: 10, svg: frame('#5a0f18', '#5a0f18') },
    { id: 'other', label: '', when: 'any', svg: frame('#2a2d35', '#2a2d35') }] });
}

// ------------------------------------------------------------------ flag: track status
{
  const flag = (fill, text, tc = '#111', pattern = '') => svg('0 0 160 110', `.t{${F};font-weight:800;font-size:22px;letter-spacing:.04em}.c{${F};font-weight:600;font-size:11px;letter-spacing:.14em;fill:currentColor;opacity:.75;text-transform:uppercase}`,
    `<defs><linearGradient id="fs" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".3" stop-color="#fff" stop-opacity=".18"/><stop offset=".55" stop-color="#000" stop-opacity=".15"/><stop offset=".8" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>${pattern}</defs>
<rect x="10" y="6" width="5" height="96" rx="2" fill="#d8dbe2"/><path d="M15 10q30-8 64 2t70-2v58q-34 10-70 0t-64 2z" fill="${fill}"><animate attributeName="d" dur="2.4s" repeatCount="indefinite" values="M15 10q30-8 64 2t70-2v58q-34 10-70 0t-64 2z;M15 10q34 6 66-2t68 4v58q-36-6-68 2t-66-4z;M15 10q30-8 64 2t70-2v58q-34 10-70 0t-64 2z"/></path><path d="M15 10q30-8 64 2t70-2v58q-34 10-70 0t-64 2z" fill="url(#fs)"/>
${text ? `<text x="82" y="47" text-anchor="middle" class="t" fill="${tc}">${text}</text>` : ''}<text x="82" y="100" text-anchor="middle" class="c">{{label}}</text>`);
  const chk = '<pattern id="ck" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#fff"/><rect width="8" height="8" fill="#111"/><rect x="8" y="8" width="8" height="8" fill="#111"/></pattern>';
  add({ id: 'race-flag', kind: 'states', name: 'Track status flag', description: 'Green, yellow, double yellow, red, safety car, virtual safety car, blue, chequered — a waving flag.', states: [
    { id: 'green', label: 'Green', when: '=', value: ['green', 'clear', 'go'], svg: flag('#16a34a', '') },
    { id: 'yellow', label: 'Yellow', when: '=', value: ['yellow', 'caution'], svg: flag('#facc15', '') },
    { id: 'double', label: 'Double yellow', when: '=', value: ['double yellow', 'double', 'yy'], svg: flag('#facc15', '!!') },
    { id: 'red', label: 'Red flag', when: '=', value: ['red', 'stop'], svg: flag('#dc2626', '') },
    { id: 'sc', label: 'Safety car', when: '=', value: ['sc', 'safety car'], svg: flag('#facc15', 'SC') },
    { id: 'vsc', label: 'Virtual SC', when: '=', value: ['vsc', 'virtual safety car'], svg: flag('#facc15', 'VSC') },
    { id: 'blue', label: 'Blue flag', when: '=', value: ['blue'], svg: flag('#2563eb', '') },
    { id: 'chequered', label: 'Finish', when: '=', value: ['chequered', 'checkered', 'finish', 'end'], svg: flag('url(#ck)', '', '#111', chk) },
    { id: 'none', label: '', when: 'any', svg: flag('#2a2d35', '') }] });
}

// ------------------------------------------------------------------ drs / any on-off pill
add({ id: 'pill', kind: 'toggle', name: 'Status pill', description: 'A pill that glows green when on (DRS open, pit lane, online). The label is its text.',
  svg: svg('0 0 140 56', `.b{fill:currentColor;fill-opacity:.1;stroke:currentColor;stroke-opacity:.25;transition:fill .4s,stroke .4s}[data-state="on"] .b{fill:#16a34a;fill-opacity:.9;stroke:#4ade80;stroke-opacity:1}.g{opacity:0;transition:opacity .4s}[data-state="on"] .g{opacity:.7}.t{${F};font-weight:700;font-size:20px;letter-spacing:.14em;fill:currentColor;opacity:.55}[data-state="on"] .t{fill:#fff;opacity:1}`,
    `<defs>${glow('pg', 6)}</defs><rect class="g" x="12" y="10" width="116" height="36" rx="18" fill="#22c55e" filter="url(#pg)"/><rect class="b" x="12" y="10" width="116" height="36" rx="18"/><text x="70" y="35" text-anchor="middle" class="t">{{label}}</text>`) });

// ------------------------------------------------------------------ write
let bad = 0;
const keep = new Set(packs.map((p) => p.id));
for (const old of ['badge', 'dash-ring', 'heart', 'flag']) if (!keep.has(old)) { try { fs.unlinkSync(path.join(OUT, old + '.json')); } catch {} }
for (const p of packs) {
  const r = validatePack(p);
  if (!r.ok || r.warnings.length) { bad++; console.error(p.id, r.errors, r.warnings); continue; }
  fs.writeFileSync(path.join(OUT, p.id + '.json'), JSON.stringify(p, null, 1) + '\n');
}
console.log(`${packs.length - bad}/${packs.length} packs written to public/viz`);
process.exit(bad ? 1 : 0);
