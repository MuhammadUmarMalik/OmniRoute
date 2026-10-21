/**
 * The builder stage must install devDependencies — in ONE install instruction.
 *
 * npm omits devDependencies whenever NODE_ENV=production is exported in the
 * build environment (npm's `omit` config defaults to ["dev"] in that case).
 * Self-hosting panels that export NODE_ENV=production for the whole build —
 * Coolify and Dokploy among them — therefore installed the image WITHOUT the
 * devDependencies, and `next build` died ~1s in with:
 *
 *   ▲ Next.js 16.3.8 (webpack)
 *   ⨯ Failed to load next.config.mjs
 *   > Build error occurred
 *   Error: Cannot find package 'fumadocs-mdx' imported from <root>/next.config.mjs
 *     at ignore-listed frames { code: 'ERR_MODULE_NOT_FOUND' }
 *
 * `fumadocs-mdx` is a devDependency imported by next.config.mjs; the CSS
 * pipeline needs @tailwindcss/postcss + tailwindcss and the React Compiler
 * needs babel-plugin-react-compiler — all devDependencies too.
 *
 * `--include=dev` is npm's documented override for the NODE_ENV-derived
 * `omit=dev`, so the builder install no longer depends on the ambient
 * NODE_ENV of the surrounding build environment.
 *
 * The v3.8.53 image build then broke a second way: the install was split over
 * two instructions with a comment block in between, and a comment inside an
 * OPEN line continuation is not a comment to BuildKit — the comment is dropped
 * but the continuation stays open, so the following `RUN --mount=…` was glued
 * onto the `npm ci` command and npm died with `Unknown cli flag: - --mount`.
 * Two invariants are therefore pinned here: exactly ONE install instruction,
 * and no comment inside a continued instruction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

type Instruction = { keyword: string; body: string; line: number };

/**
 * Parse the Dockerfile the way BuildKit does: a trailing `\` continues the
 * instruction on the next line, and a `#` line is a comment. The two rules
 * interact: a comment inside an OPEN continuation is dropped by BuildKit while
 * the continuation stays open, so the NEXT instruction is appended to the
 * current one. That is the v3.8.53 build break, so the parser rejects it
 * instead of silently folding the instructions together.
 */
function parseInstructions(source: string): Instruction[] {
  const instructions: Instruction[] = [];
  let pending = "";
  let pendingLine = 0;
  let open = false;

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("#")) {
      if (open) {
        throw new Error(
          `Dockerfile line ${index + 1}: a comment inside a continued instruction is not a comment to BuildKit — ` +
            `the comment is dropped but the continuation stays open, so the next instruction is appended to the ` +
            `instruction opened at line ${pendingLine}`
        );
      }
      return;
    }
    const continued = line.endsWith("\\");
    if (!open) {
      pending = "";
      pendingLine = index + 1;
    }
    pending += (continued ? line.slice(0, -1) : line) + " ";
    if (continued) {
      open = true;
      return;
    }
    const folded = pending.trim();
    const keyword = folded.split(/\s+/)[0].toUpperCase();
    instructions.push({
      keyword,
      body: folded.slice(keyword.length).trim(),
      line: pendingLine,
    });
    pending = "";
    open = false;
  });

  if (open) {
    throw new Error(
      `Dockerfile line ${pendingLine}: instruction ends with an open line continuation`
    );
  }
  return instructions;
}

/** Every instruction of the `builder` stage, in file order. */
function builderStage(source: string): Instruction[] {
  const all = parseInstructions(source);
  const start = all.findIndex(
    (instruction) => instruction.keyword === "FROM" && /\bAS\s+builder\b/i.test(instruction.body)
  );
  assert.ok(start >= 0, "Dockerfile must declare a `builder` stage");
  const after = all.slice(start + 1).findIndex((instruction) => instruction.keyword === "FROM");
  return after === -1 ? all.slice(start + 1) : all.slice(start + 1, start + 1 + after);
}

/** The builder-stage instructions that run `npm ci`. */
function builderInstallRuns(source: string): Instruction[] {
  return builderStage(source).filter(
    (instruction) => instruction.keyword === "RUN" && /\bnpm ci\b/.test(instruction.body)
  );
}

/** The flags of the single builder-stage `npm ci` invocation. */
function builderInstallFlags(source: string): string[] {
  const runs = builderInstallRuns(source);
  assert.equal(
    runs.length,
    1,
    "the builder stage must install in exactly ONE instruction: `npm ci` removes node_modules before " +
      "installing, so a second invocation would drop the devDependencies the build needs"
  );
  const command = runs[0].body.match(/npm ci ([^&]*)/);
  assert.ok(command, "the builder stage must run `npm ci`");
  return command[1].trim().split(/\s+/).filter(Boolean);
}

test("the builder install includes devDependencies so NODE_ENV=production cannot drop the build toolchain", () => {
  const flags = builderInstallFlags(dockerfile);
  assert.ok(
    flags.includes("--include=dev"),
    "the builder stage must pass --include=dev: npm omits devDependencies when NODE_ENV=production is exported, which breaks the build with 'Failed to load next.config.mjs' (Cannot find package 'fumadocs-mdx')"
  );
});

test("the builder install still installs optional dependencies and still blocks lifecycle scripts", () => {
  const flags = builderInstallFlags(dockerfile);
  assert.ok(
    flags.includes("--include=optional"),
    "optional dependencies (better-sqlite3, sharp, onnxruntime-node, …) must stay installed"
  );
  assert.ok(
    flags.includes("--ignore-scripts"),
    "lifecycle scripts must stay disabled for the audited checkout installation"
  );
});

test("the builder installs once — a second `npm ci` would wipe the devDependencies again", () => {
  const runs = builderInstallRuns(dockerfile);
  assert.equal(
    runs.length,
    1,
    `the builder stage must run \`npm ci\` exactly once (found ${runs.length}): npm ci wipes node_modules, so a second install without --include=dev reintroduces the 'Cannot find package fumadocs-mdx' build break`
  );
});

test("no Dockerfile comment sits inside a continued instruction (the v3.8.53 build break)", () => {
  assert.doesNotThrow(
    () => parseInstructions(dockerfile),
    "a comment inside a continued instruction makes BuildKit append the next instruction to the current one"
  );
  const broken = [
    "FROM node AS builder",
    "RUN --mount=type=cache,target=/root/.npm \\",
    "  npm ci --include=optional --include=dev --ignore-scripts \\",
    "# a comment between two instructions, inside the open continuation",
    "RUN --mount=type=cache,target=/root/.npm \\",
    "  npm ci --include=optional --ignore-scripts",
    "FROM node AS runner",
  ].join("\n");
  assert.throws(
    () => parseInstructions(broken),
    /comment inside a continued instruction/,
    "the parser must reject the v3.8.53 instruction shape (npm: Unknown cli flag: - --mount)"
  );
});

test("the builder install is not glued to a following instruction", () => {
  const [run] = builderInstallRuns(dockerfile);
  assert.ok(
    !/\bRUN\b/.test(run.body),
    `the builder install instruction swallowed another instruction: ${run.body.slice(0, 200)}`
  );
});

test("the runtime stage keeps NODE_ENV=production (the builder override is install-time only)", () => {
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
});
