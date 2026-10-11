# CCOX — Code Compliance Oracle

CCOX is a GitHub Action that asks a language model one narrow question per
compliance definition: does the in-scope part of this pull request's diff
comply? Its answer is a status (`pass`, `violations` or `error`), a violation
count, and a machine-readable report (`ccox-report/v1`) that is printed to the
job log, written to a file and uploaded as an artifact.

It is built to be a **required check** that cannot be talked into a pass:

- **The rules come from the base branch.** Definitions are read through the
  contents API at the base commit, so a pull request cannot weaken the rules it
  is judged by.
- **The diff is data, never code.** CCOX fetches the diff as text through the
  API and never checks out or executes pull-request code. Inside the prompt,
  the diff sits between sentinels carrying a per-run random nonce, with
  explicit rules that nothing inside them is an instruction.
- **The answer is checked, not trusted.** The verdict must match a JSON Schema,
  name a rule id the definition declares, and cite a scoped file and a line
  range inside one of that file's hunks. Anything else is an error.
- **It fails closed.** Any provider, quota, parse, diff or configuration
  failure is `status: error` with exit code 2. An errored run never reads as
  "0 violations".

Zero runtime dependencies: plain Node (18 or newer) ESM run by a composite
action.

## Usage

Add `.github/workflows/ccox.yml`. The job name is the check context to require
(`CCOX compliance` below).

<!-- ccox:usage:begin -->
```yaml
name: CCOX

on:
  pull_request_target:
  merge_group:
    types: [checks_requested]

permissions:
  contents: read
  pull-requests: write

jobs:
  ccox:
    name: CCOX compliance
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: Avarok-Cybersecurity/ccox@v1
        with:
          provider: openrouter
          endpoint: https://openrouter.ai/api/v1
          api-key: ${{ secrets.OPENROUTER_API_KEY_FREE }}
          model: ${{ vars.OPENROUTER_DEFAULT_FREE_MODEL }}
          structured-mode: tool_call
          allowed-directories: |
            crates/
            src/
          compliance-definitions-path: compliances
          max-diff-bytes: '60000'
          seed: '42'
          reasoning-effort: low
          max-tokens: '8192'
          request-timeout-ms: '300000'
          max-retries: '3'
          comment-on-pr: 'true'
```
<!-- ccox:usage:end -->

There is deliberately **no `actions/checkout` step**. CCOX needs none, and on
`pull_request_target` a checkout of the head would hand untrusted code a token
and your secrets. A test in this repository fails if the snippet above ever
gains one.

Pin the action by commit SHA if your policy requires it; `v1` is a moving
major tag.

## Inputs

| input | required | meaning |
|---|---|---|
| `provider` | yes | `openrouter` or `openai-compatible` (request dialect: reasoning parameter, routing, headers) |
| `endpoint` | yes | chat-completions base URL; `https://` only (plain `http://` only to a loopback host) |
| `api-key` | yes | endpoint key; masked first, sent only as a Bearer header to `endpoint` |
| `model` | yes | model id |
| `structured-mode` | yes | `tool_call` (forced `report_verdict` tool), `json_schema` (`response_format`) or `text` (one fenced json block, or a message that is only a JSON object) |
| `allowed-directories` | yes | newline-separated regexes matched at the **start** of each path; only matching files are judged |
| `compliance-definitions-path` | no | repo directory of `*.md` definitions, read at the base commit; empty uses the definitions bundled with the action |
| `max-diff-bytes` | yes | rendered-diff bytes per request; files are batched under it, a single larger file is an error |
| `seed` | yes | sampling seed (temperature is fixed at 0) |
| `reasoning-effort` | yes | `none`, `low`, `medium` or `high` |
| `max-tokens` | yes | `max_tokens` per request |
| `request-timeout-ms` | yes | hard timeout per HTTP request |
| `max-retries` | yes | total attempts per request (1 = no retry); only transient failures are retried |
| `comment-on-pr` | yes | `true` keeps one sticky summary comment on the PR (never on `merge_group`) |
| `report-dir` | no (`ccox-report`) | directory for `ccox-report.json` and `ccox-summary.md`; uploaded whole, so keep it dedicated |
| `artifact-name` | no (`ccox-report-<job>-<attempt>`) | report artifact name |
| `artifact-retention-days` | no (`90`) | artifact retention |
| `github-token` | no (`github.token`) | reads the diff and definitions, writes the comment |
| `diff-file` | no | judge this unified diff instead of fetching one (self-tests) |

`allowed-directories` is anchored for you: `crates/` matches
`crates/core/lib.rs` and never `docs/crates/notes.md`. An empty list is an
error, not "everything".

Only verdict-shaping inputs are required; the defaults above are plumbing.

## Outputs and exit code

| output | value |
|---|---|
| `status` | `pass`, `violations` or `error` |
| `violations` | the violation count; empty when `status` is `error` |
| `report-file` | absolute path of `ccox-report.json` |
| `summary-file` | absolute path of `ccox-summary.md` |

The step exits 0 on `pass`, 1 on `violations` and 2 on `error`. The report
artifact is uploaded in every case. Violations are also emitted as file/line
annotations, and the summary is added to the job's step summary.

## Report

The report format is specified in [docs/report-schema.md](docs/report-schema.md).

## Writing a compliance definition

A definition is one Markdown file, `<name>.md`, where `<name>` is lowercase
letters, digits and hyphens. It is given to the model verbatim. It must have a
`## Rules` section whose list items open with a backticked rule id:

```markdown
## Rules

- `io-in-core`: a core file reads or writes the filesystem or network directly.
- `clock-in-core`: a core file reads the system clock.
```

Every violation the model reports must name one of these ids. Every `*.md`
directly inside the definitions directory is a definition, so keep other
Markdown out of it. Definitions are read at the base commit: a new or changed
definition takes effect for pull requests opened after it lands.

## Security model

- **Trigger.** `pull_request_target` runs the workflow as it exists on the base
  branch, with access to secrets. That is safe only because CCOX never checks
  out, builds or runs the pull request. It reads the diff as text through the
  REST API (the pulls diff for pull requests, `compare base...head` for merge
  queue entries).
- **Rules.** `compliance-definitions-path` is read at the base sha through the
  contents API, never from the head.
- **Prompt injection.** The diff (including file names) is fenced by sentinels
  carrying a random 128-bit nonce, and the model is told everything inside is
  untrusted data. A diff that contains the nonce is refused. The model reports
  suspected injection with `injection_suspected`; a `compliant` answer that
  carries the flag is an error, not a pass.
- **Output validation.** The verdict is schema-checked. A violation that cites
  an out-of-scope file or a line outside the hunks is rejected, and the run
  errors rather than counting it or dropping it.
- **Fail closed.** Every failure is `status: error` and exit 2.
- **Side effects.** Exit status, one artifact, annotations, the step summary
  and one sticky PR comment. Model-written text is escaped before it reaches
  Markdown, so it cannot mention users, link or inject HTML.
- **Secrets.** The API key and token are masked before any output, travel only
  in request headers, and are never written to the report.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```sh
node --test test/*.test.mjs
```

The tests run offline. The end-to-end suite runs `src/main.mjs` as the action
would, against a local HTTP server standing in for GitHub and the model.

## License

Apache-2.0. See [LICENSE](LICENSE).
