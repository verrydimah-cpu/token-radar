// main.ts — the token radar entry (Node 22, standard library only).
//
// Reads the sealed snapshot (at /input/snapshot.json in the grader's container, or wherever
// --input points: a snapshot file or the directory holding one), scores it with the model in
// lib/model.ts, and writes the hand-in to the output directory:
//
//   board.json    the ranked board: one row per protocol, with its farm plan
//   data.js       the same board in the shape the dashboard renders
//   dashboard/    this repository's dashboard, copied
//   screenshots/  this repository's three screenshots, copied
//   dossier.json  the judge's summary, written last with buildDossier so the scorer's rebuild
//                 of it from the same output matches byte for byte
//
// The board is checked against the gate's shape before anything is written: a board the gate
// would refuse fails here first, with the reason on stderr. Run it locally with:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, restated so the dossier this program writes is the one it rebuilds. */
const DOSSIER_CAPS = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` or `--name=<value>` in the arguments, else the fallback. */
function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

// --- read and score the snapshot -------------------------------------------------------------

const inputArg = argValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const outputDir = argValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

// --- write the hand-in ------------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

/** Copy a directory tree of regular files, skipping dot-names at every level. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) {
      for (const inner of copyTree(src, dst)) copied.push(`${name}/${inner}`);
    } else if (statSync(src).isFile()) {
      copyFileSync(src, dst);
      copied.push(name);
    }
  }
  return copied;
}

const pageFiles = copyTree(join(here, 'dashboard'), join(outputDir, 'dashboard'));
const shots = copyTree(join(here, 'screenshots'), join(outputDir, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} image(s): hand in 3 — the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier goes last: it is built from the output as it now stands.
writeFileSync(join(outputDir, 'dossier.json'), buildDossier(outputDir, DOSSIER_CAPS));

const podium = board
  .slice(0, 3)
  .map((r) => `#${r.rank} ${r.slug} $${r.implied_value_usd.toLocaleString('en-US')}`)
  .join(' · ');
process.stdout.write(
  `token radar: snapshot of ${snapshot.as_of}: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist\n` +
    `token radar: board of ${board.length} rows (${radar.stats.set_aside} pre-token set aside by hygiene)\n` +
    `token radar: podium: ${podium}\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images), dossier.json to ${outputDir}\n`,
);
