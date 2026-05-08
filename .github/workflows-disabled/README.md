# Disabled upptime workflows

These five workflows (`graphs.yml`, `response-time.yml`, `static-site.yml`,
`summary.yml`, `uptime.yml`) are upptime-driven and call
`api.github.com` for releases lookup, issue management, and result
commits.

Post the 2026-05-06 GitHub org suspension, no token in our org
authenticates against api.github.com, so every scheduled run fails
with HTTP 401 "Bad credentials". See molecule-ai-status#2 for full
diagnosis + the replacement plan.

Workflows here will not be re-enabled — they're moved to
`workflows-disabled/` so the failed-run noise stops while the
replacement (Gitea-native uptime probe) is built. Delete this
directory after the replacement lands and the existing history is
either migrated or marked archived.

Tracked: molecule-ai-status#2
