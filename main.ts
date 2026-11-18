// Token Launch Radar — token-radar-01 entry (Node 22, standard library only, deterministic).
//
// Reads the sealed snapshot, prices every pre-token protocol with lib/model.ts, writes:
//   /output/board.json        { rows: [...] } — the gate reads this
//   /output/data.js           window.BOARD_DATA / window.BOARD_META for the page (kept outside dashboard/
//                             so the dossier's 64 KB text shows the page's source whole, not the data)
//   /output/dashboard/        index.html, app.css, app.js copied from this repository
//   /output/screenshots/      the three PNGs copied from this repository
//   /output/dossier.json      buildDossier() from the vendored make.fun library, written last
//
// Environment: MAKEFUN_INPUT (default /input/snapshot.json), MAKEFUN_OUTPUT_DIR (default /output).
// Flags --input <file|dir> and --output <dir> override them. No clock, no randomness, no network:
// two runs on the same snapshot write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildBoard, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(msg: string): never {
  process.stderr.write(`token radar: ${msg}\n`);
  process.exit(1);
}

const inputArg = arg('input', process.env.MAKEFUN_INPUT ?? '/input/snapshot.json');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: set MAKEFUN_INPUT or pass --input <snapshot.json|dir>`);
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ---------------------------------------------------------------- model
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { rows, meta } = buildBoard(snapshot);
const issue = boardIssue(rows, snapshot);
if (issue !== null) fail(`the board would fail the gate: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows })}\n`);
writeFileSync(
  join(out, 'data.js'),
  `// Written by main.ts from ${meta.as_of}'s snapshot: the same rows as board.json.\n` +
    `window.BOARD_META=${JSON.stringify(meta)};\n` +
    `window.BOARD_DATA=${JSON.stringify(rows)};\n`,
);

// ---------------------------------------------------------------- page and screenshots
/** Replace `to` with the regular, non-dot files of `from`, in name order. */
function copyFiles(from: string, to: string): string[] {
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    const path = join(from, name);
    if (name.startsWith('.') || !statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const page = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
for (const need of ['index.html', 'app.css', 'app.js']) if (!page.includes(need)) fail(`dashboard/${need} is missing`);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images: hand in 3 (board, detail, filtered)`);
for (const name of shots) if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -`);

// ---------------------------------------------------------------- dossier, last
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const watched = rows.filter((r) => r.in_watchlist).length;
process.stdout.write(
  `token radar: ${meta.protocols} protocols, ${meta.pre_token} pre-token, ${meta.comparables} priced comparables ` +
    `(mcap = ${meta.fit.scale} x tvl^${meta.fit.b}, R2 ${meta.fit.r2})\n` +
    `token radar: ${rows.length} rows (${watched}/${meta.watchlist} watchlist + ${meta.extras} extras), top ${rows[0]!.slug} at $${rows[0]!.implied_value_usd}\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${page.length} files), screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
);
