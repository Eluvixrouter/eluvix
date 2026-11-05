# Eluvix Changelog

This file is the tag-accurate record of what shipped in each release. Every
entry below is sourced from the git history between that version's tag and
the previous one (`git log vX.Y.Z..vA.B.C`, excluding the `chore(release)`
bump commits), not from prose written ahead of the release.

## How to keep this file updated (release process)

1. After `scripts/release-tagger.sh` creates a new version tag, add an entry
   at the top of this file for the new version, dated with the tag's date,
   summarizing the feature/fix commits between the previous tag and the new
   one. The tagger prints this reminder on every successful bump.
2. Do not copy entries from the docs site's releases page without checking
   them against the tags: that page's v1.0.15–v1.0.17 entries describe the
   CRS, ArtCraft, and FlashAttention-3 features whose commits fall in the
   1.0.18, 1.0.19, and 1.0.21 tag ranges respectively (see the note under
   1.0.5 below for the other known gap). When prose and tags disagree, the
   tags win.
3. If a bump commit is never tagged (see 1.0.5), record that here instead
   of inventing a tag after the fact.

For releases up to and including 1.0.17, the docs site's releases page
(`apps/githubio/src/app/docs/releases/page.mdx`) carries the long-form
notes, subject to the numbering caveat in (2). From 1.0.18 on, this file
is the changelog; the releases page is not backfilled here beyond the
tag-sourced summaries below.

## Unreleased (on main after 1.0.21, 2026-11-05 – 2026-11-11)

No tag and no version bump exists for this work yet: `package.json`,
`VERSION`, and the latest tag all still read `1.0.21`. The `v1.1.0` /
`v1.2` labels below come from the commit subjects only, not from a
release. Re-title this section into versioned entries when
`scripts/release-tagger.sh` creates the tags (see the process note
above); do not invent tag dates before then.

- Bug-hunt fix batch across router-core, Next.js editor, desktop, and
  harnesses (`fix`, commit `363928e`, PR #16, merged 2026-11-12).
- Gemini 4 Carbon, ComfyUI media synthesis, RamaLama OCI, Pro Studio
  editor, Prometheus metrics, and a 24h spend cap (`feat`, commit
  `4c9c64d`). Adds example layouts 21 (Sovereign OCI Container Triad)
  and 22 (ComfyUI + Local LLM + ArtCraft Creative Studio Pipeline).
- `AGENTS.md` engineering rules: mandatory docs sync, testing gates,
  and architectural guardrails (`docs`, commit `724a25e`).
- "v1.1.0" work (`feat(v1.1.0)`, commit `358539e`): universal
  wire-protocol gateway, speculative cascades, Thompson bandit, SFT/DPO
  distillation, sovereign MCP server, cooperative VRAM arbiter, and
  Golden Evals.
- "v1.2" work (`feat(v1.2)`, commit `ca80419`): enterprise gateway
  hardening, OpenTelemetry exporter, and operator APIs.

## 1.0.21 — 2026-11-01

- FlashAttention-3 warp-specialization, TMA 128B swizzling, and Blackwell
  `tcgen05` TMEM co-design (`feat(router-core,editor)`, commit `25e9d8c`).

## 1.0.20 — 2026-11-01

- Example 19 now routes with Lemonade multi-model routing instead of
  Claude (`feat(layouts)`, commit `7c8d310`).
- VectorCraft node exposes a bidirectional MCP target handle and write
  loop (`feat(editor)`, commit `7d9dbbf`).
- New bundled example layout: OpenCode + VectorCraft Art Studio
  (`feat(layouts)`, commit `e8ba744`).
- Branding: "Billama Visual Node Routing Editor" renamed to "Eluvix
  Visual Node Routing Editor" (`fix(branding)`, commit `a2f6003`).

## 1.0.19 — 2026-11-01

- VectorCraft art MCP node, router context, and compiler support
  (`feat(mcp)`, commit `4ddede3`).
- Full 14-app ArtCraft Suite integrated into router-core, the visual
  canvas, and the compiler (`feat(mcp)`, commit `f920f32`).

## 1.0.18 — 2026-10-31

- Neuro-symbolic program slicing, sanitizer triage, and stall escalation
  for CRS (`feat(crs)`, commit `4c0d060`).

## 1.0.5 — never tagged (2026-10-23, documented, not tagged)

- The bump commit `8230e21` ("chore(release): bump version to 1.0.5")
  exists, but no `v1.0.5` tag was ever created — the tag series jumps
  from `v1.0.4` to `v1.0.6` — and no `v1.0.5` GitHub release exists
  (checked via `gh release view v1.0.5`: "release not found").
- No tag is created retroactively here: a local-only tag would not
  survive pushing the branch, and inventing release history is worse
  than recording the gap. Anyone scripting "tag == package version"
  checks should expect the gap at 1.0.5.
