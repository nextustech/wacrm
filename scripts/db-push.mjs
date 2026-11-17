#!/usr/bin/env node
/**
 * Push migrations to the right remote Supabase project — safely.
 *
 * Two things kept going wrong by hand:
 *
 * 1. Supabase CLI v3 changed `db push` to target the LOCAL stack by default,
 *    so `npx supabase db push` fails with
 *    `dial error (connect ECONNREFUSED 127.0.0.1:54322)` unless Docker is
 *    running — which is never what we want here. The remote now has to be
 *    asked for explicitly with `--remote`.
 *
 * 2. The CLI link and the app's own `.env` can point at different projects.
 *    `--remote` on its own silently pushes to whatever the CLI happens to be
 *    linked to, which may be a customer's database.
 *
 * This resolves the target from `.env` (the project the app actually talks to),
 * refuses to run when the CLI link disagrees, and then pushes with an explicit
 * project ref so there is nothing left to guess.
 *
 *   npm run db:push            push every pending migration
 *   npm run db:push -- --dry-run
 *   npm run db:push -- --ref=<project-ref>     target another project on purpose
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

function fail(message, hints = []) {
  console.error(`\n${red("db:push stopped.")} ${message}`);
  for (const hint of hints) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

/** Read one key out of a .env file without pulling in a dependency. */
function envValue(file, key) {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

/** `https://abcdefgh.supabase.co` -> `abcdefgh`. */
const refFromUrl = (url) => {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|red)/i.exec(url ?? "");
  return m ? m[1] : null;
};

const args = process.argv.slice(2);
const explicit = args.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) ?? null;
const passthrough = args.filter((a) => !a.startsWith("--ref="));

// The project the running app points at: the only sane default for migrations.
// Both files are searched, in Vite's own precedence order, because .env.local
// usually overrides only a few keys and leaves the URL in .env.
const envFiles = [".env.local", ".env"].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
let envRef = null;
let envFile = envFiles[0] ?? null;
for (const file of envFiles) {
  const ref =
    refFromUrl(envValue(file, "SUPABASE_URL")) ?? refFromUrl(envValue(file, "VITE_SUPABASE_URL"));
  if (ref) {
    envRef = ref;
    envFile = file;
    break;
  }
}

// What the CLI is currently linked to.
const linkFile = path.join(root, "supabase", ".temp", "linked-project.json");
let linked = null;
if (fs.existsSync(linkFile)) {
  try {
    linked = JSON.parse(fs.readFileSync(linkFile, "utf8"));
  } catch {
    linked = null;
  }
}

const target = explicit ?? envRef ?? linked?.ref ?? null;
if (!target) {
  fail("Could not work out which Supabase project to push to.", [
    `No SUPABASE_URL / VITE_SUPABASE_URL in .env.local or .env, and the CLI is not linked.`,
    dim("Fix: npx supabase link --project-ref <project-ref>   (or run: npm run db:push -- --ref=<project-ref>)"),
  ]);
}

if (!explicit && envRef && linked?.ref && linked.ref !== envRef) {
  fail("The Supabase CLI is linked to a different project than this app uses.", [
    `${yellow("CLI is linked to")}  ${linked.ref}${linked.name ? ` (${linked.name})` : ""}`,
    `${yellow("This app uses")}     ${envRef}   ${dim(`from ${path.relative(root, envFile)}`)}`,
    "",
    "Pushing now would apply these migrations to the wrong database.",
    dim(`Fix the link:      npx supabase link --project-ref ${envRef}`),
    dim(`Or push on purpose: npm run db:push -- --ref=${linked.ref}`),
  ]);
}

const flags = ["db", "push", `--remote=${target}`];
if (!passthrough.includes("--include-all")) flags.push("--include-all");
if (!passthrough.includes("--dry-run") && !passthrough.includes("--yes")) flags.push("--yes");
flags.push(...passthrough);

const label = explicit ? `${target} (explicit --ref)` : linked?.name ? `${target} (${linked.name})` : target;
console.log(`\n${green("→")} supabase db push ${dim(`→ remote project ${label}`)}\n`);

const run = spawnSync("npx", ["--yes", "supabase", ...flags], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(run.status ?? 1);
