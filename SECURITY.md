# Security Policy

## Supported versions

Only the most recent release line receives security fixes. Before the first
release, `main` is the only supported version.

## Reporting a vulnerability

Email **security@avarok.com** with a description, a proof of concept if you
have one, and the action version (tag or commit sha) you tested. We aim to
acknowledge reports within 3 business days.

Please do **not** open a public issue for security reports. A way to make CCOX
pass a non-compliant change (a prompt-injection bypass, a scope escape, a
parse path that reads as a pass) is a security issue.

## What CCOX guarantees

- It never checks out, builds or executes pull-request code. The changed files,
  their patches and (for an in-scope file without a patch) their contents are
  read as text through the GitHub API, which is what makes
  `pull_request_target` safe here.
- It judges the whole in-scope diff or none of it: a listing that cannot be
  proven complete, or an in-scope file whose diff cannot be read, is an error.
- Compliance definitions configured with `compliance-definitions-path` are read
  at the base commit, never from the pull request's head.
- Every failure (inputs, event, definitions, GitHub, diff, provider, quota,
  timeout, unparsable or inconsistent verdict, out-of-scope citation, suspected
  injection with a `compliant` answer) yields `status: error` and exit code 2.
  An errored run never reports 0 violations.
- Model output is untrusted: schema-validated, checked against the scoped files
  and hunks, and escaped before it is written into Markdown.

## How the API key and token are handled

- They reach the action only through environment variables mapped by
  `action.yml`; they are never interpolated into a command line or URL.
- The entrypoint registers both with `::add-mask::` before any other output.
- The API key is sent only as an `Authorization: Bearer` header to the
  configured `endpoint`, which must be `https://` (plain `http://` is accepted
  only for a loopback host). The token is sent only to the GitHub API.
- Neither is written to the report, the summary, outputs or the artifact.

## Supply chain

- Zero npm dependencies; the action runs the plain Node sources in this
  repository.
- Third-party actions, including the artifact upload inside `action.yml`, are
  pinned by full commit sha.
- CI downloads `actionlint` at a pinned version and verifies its sha256 before
  running it.
