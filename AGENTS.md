# Agent notes

Read [README.md](README.md) for connector behavior and validation commands. This
connector is also deployed into isolated Hermes business profiles. Before changing
that integration, read the Ansible repository's
[Hermes maintenance contract](https://github.com/PineappleCare/kisstech_ansible/blob/master/HERMES.md)
(`../../kisstech_ansible/HERMES.md` in the workspace).

- Shared connector code may improve generically; company knowledge, credentials,
  operational skills and memories remain separate. Do not put company-specific
  lessons into shared connector code or overwrite deployed Hermes skill files.
- New tools require explicit profile/channel exposure through existing discovery.
  Hermes currently grants the approved Jobber write surface to Williams Desktop;
  preserve WhatsApp write restrictions and neutral/default denial.
- Teach new or changed contracts with a concise capability reference or a reviewed,
  targeted skill migration. Preserve unrelated learned procedures and metadata.
  Ansible seeds initialize profiles once; they do not overwrite existing learning.
- Keep explicit confirmation, complete human-review payloads, fresh record/version
  and membership checks, readback, and reconciliation of partial/ambiguous outcomes.
  Do not automatically retry uncertain mutations or claim exactly-once behavior
  across crashes. Mock-only verification is not evidence of a live business write.
- `update_job_line_item_descriptions` must mutate only IDs and descriptions, preserve
  prices/quantities/taxes and other fields, and report per-line verified results.
- For incompatible changes or deprecation, update the connector and its intended
  exposure together, migrate only affected procedures with conflict/repeat checks,
  and retain unrelated learning/history. Removing a capability is not permission
  to replace an entire profile or its operational skill.
