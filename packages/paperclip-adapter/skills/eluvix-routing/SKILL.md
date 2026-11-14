---
name: eluvix-routing
description: Consult Eluvix Switchyard fleet capabilities and assignee recommendations before delegating Paperclip issues or hiring new agents.
---

# Eluvix Switchyard Delegation Skill

When acting as CEO or manager in Paperclip:

1. **Before assigning an unassigned issue**, call `eluvix:recommend_assignee` with the issue ID (or title/description/priority/labels) and the available employees.
2. **Prefer the top recommendation** unless you have task-specific context that overrides it. If you choose a different employee, briefly explain why in an issue comment.
3. **Confidentiality rule**: For issues marked `confidential` or containing PII/secrets, **never** assign to cloud-egress agents. Use only `local-only` or `eluvix_local` local-egress employees.
4. **When hiring new agents**, call `eluvix:capabilities` to inspect active local and cloud engines, and prefer `eluvix_local` with model `eluvix/auto` so Switchyard dynamically selects the optimal model per turn.
5. **Never** include `elx_` API keys or Paperclip JWTs in prompts, comments, or issue descriptions.
