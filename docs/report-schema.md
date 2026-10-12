# `ccox-report/v1`

Every CCOX run produces exactly one report, whether it passes, finds violations
or fails. The report is:

- printed to the job log as one block between `----- BEGIN ccox-report/v1 -----`
  and `----- END ccox-report/v1 -----`;
- written to `<report-dir>/ccox-report.json` (the `report-file` output);
- uploaded, with `ccox-summary.md`, as the workflow artifact `artifact-name`.

The producer is `src/core/report.mjs` (`buildReport`, `aggregateCompliance`).
Fields are never omitted. A value that is unknown at the point a run failed is
`null` (or `[]`).

## Status and exit code

| `status` | exit code | meaning |
|---|---|---|
| `pass` | 0 | at least one compliance was evaluated, none errored, none found a violation |
| `violations` | 1 | no errors, and at least one violation was found |
| `error` | 2 | anything went wrong; `error` says what |

An `error` report is never a pass and never "0 violations":
`totals.violation_count` is `null` and the `violations` output is empty.
Violations found before the failure stay visible in
`compliances[].violations` and `totals.violations_found`.

## Top level

| field | type | notes |
|---|---|---|
| `schema` | `"ccox-report/v1"` | |
| `generated_at` | string | ISO-8601 UTC |
| `status` | `pass` \| `violations` \| `error` | |
| `error` | `null` \| `{ kind, message }` | the run-level error, or the first compliance error |
| `action` | `{ repository, ref }` | the CCOX action that ran; both `null` for a local `uses: ./` |
| `context` | object \| `null` | `null` when the inputs were invalid |
| `scope` | object \| `null` | `null` when the run failed before the diff was scoped |
| `model` | object \| `null` | `null` when the inputs were invalid |
| `compliances` | array | one entry per definition evaluated |
| `totals` | object | |
| `comment` | `{ status, reason? }` | `created`, `updated`, `skipped` or `failed`; a failed comment is a warning, not an error |

### `error.kind`

`input`, `event`, `definitions`, `github`, `diff`, `diff_truncated`,
`diff_too_large`, `diff_unavailable`, `file_over_budget`, `provider`, `quota`,
`timeout`, `parse`, `invalid_verdict`, `invalid_violation`,
`injection_suspected`, `internal` (the list in `src/core/errors.mjs`).

- `diff_truncated`: the diff is cut short, or the changed-file listing cannot
  be proven complete (fewer or repeated files than the pull request's
  `changed_files`, or a commit listing whose line counts do not add up to the
  commit's stats).
- `diff_too_large`: more changed files than GitHub can list completely (over
  3,000 for a pull request; 300 or more for a merge group whose head commit is
  not a single squash on the base).
- `diff_unavailable` (since 1.1.0): GitHub listed an in-scope file without a
  patch and its base or head contents could not be read. The message names the
  file.

- `quota`: the model's daily allowance is exhausted. It is not retried.
- `invalid_violation`: the model cited a file outside the scoped batch, or a
  line range outside every hunk of the new file. The cited items are in
  `rejected_violations`.
- `injection_suspected`: the model flagged prompt injection in the diff and
  still answered `compliant`. That answer is not accepted as a pass.

### `context`

| field | type | notes |
|---|---|---|
| `repository` | string | `owner/name` |
| `event` | string | e.g. `pull_request_target`, `merge_group` |
| `pr` | integer \| `null` | `null` on `merge_group` |
| `base_sha`, `head_sha` | string \| `null` | the commits the diff spans |
| `definitions` | `{ source, path, ref }` \| `null` | `source` is `base-ref` (read at `ref`, the base sha) or `bundled` |
| `diff_source` | `pulls` \| `compare` \| `commit` \| `diff-file` \| `null` | `pulls`: the pull request's files API; `compare`: `compare base...head`; `commit`: the merge group head commit's files (compare was capped); `diff-file`: the `diff-file` input |
| `run` | `{ id, attempt, job, url }` | from the runner; `null` members outside Actions |

### `scope`

| field | type | notes |
|---|---|---|
| `allowed_directories` | string[] | the regexes as given (matched at the start of the path) |
| `files_changed` | integer | files listed by GitHub, or in `diff-file` |
| `files_expected` | integer \| `null` | the pull request's `changed_files`, which `files_changed` must equal; `null` where GitHub gives no count (`compare`, `commit`, `diff-file`). Since 1.1.0 |
| `files_without_patch` | string[] | files GitHub listed without a patch (binary, or a diff too large to inline), in or out of scope. Since 1.1.0 |
| `files_content_diffed` | string[] | in-scope files among those whose diff CCOX computed from their base and head contents. Since 1.1.0 |
| `files_scanned` | string[] | judged by the model |
| `files_excluded` | string[] | outside `allowed-directories` |
| `files_skipped` | `{ path, reason }[]` | in scope with nothing to judge: `binary` (excluded binary file, never sent to the model), `deleted`, `no_content_change` (including a rename GitHub lists with no changed lines and no patch) |
| `scanned_bytes` | integer | rendered diff bytes sent, summed over files |
| `max_diff_bytes` | integer | the per-request budget |
| `batches` | integer | requests per compliance |

### `model`

`{ provider, endpoint, model, structured_mode, temperature, seed,
reasoning_effort, max_tokens }`. `temperature` is always `0`. The API key is
never recorded.

### `compliances[]`

| field | type | notes |
|---|---|---|
| `name` | string | the definition's file name without `.md` |
| `definition_sha256` | string | sha256 of the definition text exactly as used |
| `rules` | string[] | rule ids the definition declares |
| `status` | `pass` \| `violations` \| `error` | |
| `verdict` | `compliant` \| `non_compliant` \| `null` | `null` when a batch errored or no file was in scope |
| `injection_suspected` | boolean | true if any batch answer set it |
| `violation_count` | integer | accepted violations |
| `violations` | violation[] | |
| `rejected_violations` | (violation + `reason`)[] | citations that failed the scope/hunk check |
| `error` | `null` \| `{ kind, message }` | the first batch error |
| `batches` | batch[] | |

A **violation** is `{ file, line_start, line_end, rule, explanation, evidence }`;
`line_start..line_end` are new-file line numbers inside one hunk.

A **batch** is `{ index, files, status, verdict, raw_response_sha256,
response_model }`. `raw_response_sha256` is the sha256 of the provider's raw
HTTP response body, `null` when no response was received.

### `totals`

| field | type | notes |
|---|---|---|
| `compliances` | integer | |
| `passed`, `with_violations`, `errored` | integer | compliance counts by status |
| `violation_count` | integer \| `null` | `null` whenever `status` is `error` |
| `violations_found` | integer | accepted violations, also on an errored run |
| `injection_suspected` | integer | compliances whose answer set the flag |

## Compatibility

Additive fields may appear in later `v1` releases. Any change to an existing
field's meaning or type ships as `ccox-report/v2`.

1.1.0 is additive and stays `ccox-report/v1`: new `scope` fields
(`files_expected`, `files_without_patch`, `files_content_diffed`), the
`diff_source` value `commit`, and the error kind `diff_unavailable`.
`files_changed` still counts the changed files; they now come from GitHub's
files listings instead of a single diff.
