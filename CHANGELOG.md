# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-11

### Fixed

- Large pull requests can be judged. 1.0.0 fetched the diff through GitHub's
  single-diff media type, which GitHub refuses (HTTP 406) past 300 files or
  20,000 lines, so on such a pull request the run always ended in
  `diff_too_large` and the required check could never pass. CCOX now lists the
  changed files and their patches through the files API instead: the pull
  request's files (paged, up to GitHub's 3,000-file limit) on `pull_request` /
  `pull_request_target`; `compare base...head` on `merge_group`, falling back
  to the head commit's files when compare reaches its 300-file cap and the
  group is one squash on the base.
- Completeness is verified, not assumed: the listing must name exactly the
  pull request's `changed_files` distinct files, or, for the commit fallback,
  add up to the commit's line stats. Otherwise the run fails closed
  (`diff_truncated` / `diff_too_large`).

### Added

- In-scope files that GitHub lists without a patch (very large file diffs)
  are diffed from their merge-base and head contents with a built-in minimal
  line diff (no dependency), then batched and judged like any other file.
  Binary files are reported as skipped with reason `binary` and never judged.
  If the contents cannot be read, the run fails with the new error kind
  `diff_unavailable` naming the file. Files outside `allowed-directories` are
  never read.
- `ccox-report/v1` additions (compatible): `scope.files_expected`,
  `scope.files_without_patch`, `scope.files_content_diffed`, the
  `context.diff_source` value `commit`, and the error kind
  `diff_unavailable`. The summary states how many changed files were listed
  against GitHub's count, and how many were binary.

### Changed

- The README usage example and the live self-test use the dedicated secret
  `OPENROUTER_API_KEY_FREE_CCOX`, so CCOX's free-model quota is not shared
  with other workflows.
- CCOX runs on its own pull requests (`.github/workflows/ccox.yml`, scope
  `src/`).
- The single-diff fetch path is removed; a unified diff is parsed only from
  the `diff-file` input (self-tests).

## [1.0.0] - 2026-10-11

### Added

- Composite action `CCOX Code Compliance Oracle`: judges the in-scope part of a
  pull request's diff against each compliance definition with a language
  model, and reports `pass` (exit 0), `violations` (exit 1) or `error`
  (exit 2).
- Diff from the GitHub API only: the pulls diff on `pull_request` /
  `pull_request_target`, `compare base...head` on `merge_group`, or a local
  `diff-file`. The diff's file count is checked against GitHub's; a refused,
  capped or truncated diff is an error.
- `allowed-directories` regex allowlist, anchored at the start of the path;
  an empty list is an error. Batching under `max-diff-bytes`; a single file
  over the budget is an error.
- Definitions read at the base commit through the contents API when
  `compliance-definitions-path` is set, else the bundled `compliances/`.
- Prompt with the definition verbatim and the diff inside random-nonce
  sentinels; structured modes `tool_call`, `json_schema` and `text` (one
  fenced json block, or a message that is only a JSON object, which is how
  the free Nemotron answers).
- Verdict validation: JSON Schema, rule ids from the definition, citations
  restricted to scoped files and hunk lines, injection flag handling.
- Provider handling: HTTP-200-with-error bodies, transient retry with
  backoff, daily free-model quota detected and not retried, hard timeouts.
- `ccox-report/v1` (docs/report-schema.md): printed to the log, written to
  `report-dir`, uploaded as an artifact; markdown summary in the step summary,
  a summary file and an optional sticky PR comment; violation annotations.
- Bundled compliance definition `compliances/sbio.md` (Separation of Business
  logic and I/O): rules `io-in-core`, `concrete-adapter-in-core`,
  `config-in-core`, `clock-in-core` and `implicit-default`, with four
  non-compliant/compliant examples.
- Live self-test workflow (`selftest.yml`): the action against the free
  OpenRouter model on known-compliant, known-violating, prompt-injection and
  out-of-scope diffs, on pull requests, on demand and weekly, each asserting
  its declared outcome (`test/selftest/expectations.json`).
