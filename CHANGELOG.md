# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added
- 2026-11-25: Phase 2 foundation.
  - Command catalog compiled from YAML, with schema and cross-reference validation.
  - Command registry: one execution path with platform, capability, argument and enablement checks.
  - Context expressions, layered keymaps, multi-key sequences, modal keyboard mode.
  - Menu layouts (Modern, 1994 Minimal, 1999 Suite, generated Everything) and command palette.
  - Electron shell: tabs, separate UI and web sessions, sandboxed renderers, validated IPC.
  - Navigation, network-destination, permission, download and startup policies.
  - Built-in Gopher client rendered as script-free pages.
  - Flash emulation through Ruffle, per-tab opt-in.
  - 66 unit tests, 46 end-to-end checks, CI workflow.
  - Architecture, security model, decisions, integrations and handoff documents.
- 2026-11-24: Project metadata: README, ROADMAP, COST-ESTIMATE, command-catalog schema, contributing guide, issue template. No application code yet.
