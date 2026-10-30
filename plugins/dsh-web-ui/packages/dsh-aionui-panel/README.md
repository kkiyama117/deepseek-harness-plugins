# dsh-aionui-panel

English | [中文](README.zh.md)

> **Retired.** This package no longer mounts the AionUi Explorer/Preview columns or the `/aionui-panel/*` host routes. The right-panel side card is [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — an external plugin that must be installed separately; until then the settings card reports it unavailable.

## What still runs

- **Host** (`src/index.ts`): the `aionui-panel` settings namespace (availability anchor). The deprecated `rightPanel` field is accepted so old `settings.yaml` documents still validate; its value is ignored everywhere. `src/host/` is **not** imported and is **not** registered.
- **Client** (`src/client/`): the Side Card settings card under Settings → Web UI Plugins. Leftover composer drop-target and transcript mermaid sentinels stay registered; they are inert without the panel columns (`[data-aionui-preview-col]` is never created).

Installing this package or the family aggregate does **not** restore Explorer, Preview, fs/git HTTP routes, or a provider choice. Finer side-card settings live in the `dsh-better-sidebar` namespace of `~/.dsh/settings.yaml`.

## Structure (current vs historical)

- `src/index.ts` — host settings namespace only.
- `src/client/AionUiSettingsCard.tsx` / `SideCardPrefs.tsx` — active Side Card card.
- `src/host/` — unsupported historical record (routes, workspace gate, git poll). Kept because reference analysis still has callers inside that folder; `apply` does not mount them. Do not treat comments there as live behavior.

## Historical record (not mounted)

A pixel-faithful re-implementation of AionUi's right-panel system (Apache-2.0 reference, not a copy): Explorer (file tree / filename search / Git changes) + Preview (multi-tab, 10+ formats) + `/aionui-panel/*` loopback-fenced host routes. That path was removed from `apply` when the provider choice was deleted. The family aggregate still inserts this package's row so the settings card remains; a later release may drop the row.

## Attribution

Sizes, colors, and interaction parameters were measured against AionUi v2.1.53 (iOfficeAI/AionUi, Apache-2.0). Implementation is new code. Upstream copyright belongs to the AionUi project.
