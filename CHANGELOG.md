# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  sentinels; structured modes `tool_call`, `json_schema` and `text`.
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
