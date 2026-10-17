# Contributing to dsh-chat-import

Thanks for considering a contribution! `dsh-chat-import` imports external agent
conversation histories into DeepSeek Harness as full-fidelity, resumable
sessions. The user-facing contract lives in [README.md](../README.md) (bilingual),
and the repo's engineering rules — layout, commit discipline, DSH plugin
constraints, quality conventions — live in [AGENTS.md](../AGENTS.md).

## Dev setup

- **Node.js >= 22.13** (first release where `node:sqlite` is available without a flag)
- `npm ci` — install dependencies (zero runtime deps; peers auto-installed)
- `npm test` — the `node:test` suite (converter unit + export unit + host mock integration)
- `npm run check:linux` — cross-platform path-discipline guard (enforced in CI)
- `npm run lint` — eslint (flat config)
- `npm run build` — publish-surface self-check (files whitelist + syntax + lockfile version)

## What counts as a change

- **Behavior changes stay honest**: README.md and README.zh-CN.md must stay in
  sync (CI compares heading structure), tests describe the behavior, and any
  file newly referenced by `index.mjs` or the READMEs must join the `files`
  whitelist in `package.json`.
- **Plugin, not engine**: new behavior goes through public dsh host services
  (`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`, optional
  `webServer` / `commands`). Never modify the dsh engine, apiproxy, or official
  UI packages.
- **Imported session logs are append-only and deep-frozen**: never rewrite
  history events; surface events carry `surfaceOp: 'append'`.
- **Fail loudly**: malformed lines and suspected secrets are counted and
  reported, never silently swallowed.

## CHANGELOG

Release notes are taken verbatim from the matching CHANGELOG section, so the
section **is** the release note — write it for users, not for the diff. Since
0.19.0 every section follows the dsh release-note layout: a
`[中文](#cn-x.y.z) | [English](#en-x.y.z)` switch line, an
`<h3 id="cn-x.y.z">新增功能</h3>` block in Chinese, then an
`<h3 id="en-x.y.z">New Features</h3>` block in English. Within each language the
groups are `### 体验优化` / `### 问题修复` / `### 其他变更` (English:
`### Improvements` / `### Bug Fixes` / `### Chores`) in that order, whole groups
are omitted when empty, and the section ends with
`**Full Changelog**: [v-prev...v-this](compare url)`.

One bullet = one verifiable behavior or contract, not an implementation diary.
Call out contract changes explicitly (tool names, output schema, whether a source
is still supported), attach measured numbers to performance work, and keep
user-facing behavior in sync with the READMEs. Anchor ids carry the version so
multiple sections can coexist on the one page.

## Releases

A release starts from a tag the maintainer pushes (`git push --follow-tags`): that
commit already carries the version's CHANGELOG section and the bumped
`package.json`. `.github/workflows/release.yml` runs on the tag, checks that the
tag names `package.json`'s version and that the commit is on `main`, validates the
CHANGELOG section with `node scripts/release-notes.mjs --version x.y.z --check`
(the same script prints the notes), runs the full gate set, publishes to npm from
the tag with trusted publishing and provenance (no stored token), and creates or
updates the GitHub Release from that section. There is no local publish step;
rerunning the workflow skips a version already on npm, and dispatching it by hand
(one `tag` input) validates every step without publishing.

## Commits & PRs

- Conventional commits (`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` /
  `test:`), one logical change per commit; existing history uses Chinese
  descriptions.
- Before pushing: `npm test` + `npm run check:linux` green, working tree clean
  (no `dev/`, `node_modules/` or snapshots staged), `git diff --cached --check`
  clean.
- Fork → `feature/<name>` branch → open a PR (template included). The repo
  pushes straight to `main`; please don't rewrite published history.
- PRs are welcome for new import sources, fidelity upgrades, and the items on
  [ROADMAP.md](ROADMAP.md).

## Security & privacy

Never commit credentials, real user transcripts, or anything under `dev/` (the
local engineering surface, gitignored). In issues and PRs, use **synthetic**
fixtures — no real conversation content.
