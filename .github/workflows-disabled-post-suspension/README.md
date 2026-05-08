# Disabled upptime workflows

These five workflows were the upptime-driven status page. They have been
disabled because upptime fundamentally cannot run on Gitea Actions:

- `uptime/uptime-monitor` action calls `api.github.com/repos/upptime/uptime-monitor/releases`
  on every run to check its own version. This call:
  - Returns `401 Bad credentials` because the GitHub `Molecule-AI` org
    PAT was suspended on 2026-05-06.
  - Cannot be papered over with the operator host's anonymous IP — also
    rate-limited.
  - Cannot be re-tokenized with a personal GitHub PAT (the original
    bot-ring fingerprint that got us banned, per memory
    feedback_github_botring_fingerprint).

The replacement plan is tracked in `internal#TBD` (RFC).

If you need a status page in the meantime: external services
(StatusPage.io, BetterStack, healthchecks.io) sit outside the Molecule-AI
infra and don't depend on GitHub. We picked one of those for the gap.
