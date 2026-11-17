# Changelog

## 0.3.0

- `verify --staged` checks only the paths git is about to commit, so turnstamp
  works as a pre-commit hook without blocking on unrelated edits.
- `.turnstampignore`: gitignore-shaped patterns for paths that should never be
  hashed. Patterns without a slash match at any depth, a trailing slash matches
  directories only.
- `hashTree` now reports how many paths it inspected and skipped, which is the
  number you want when a run feels slow on a big repo.
- Seven tests covering the ignore rules.

## 0.2.2

- Accept `--help` anywhere on the command line.

## 0.2.0

- `turnstamp install` for both OpenCode and Claude Code, with attribution.
