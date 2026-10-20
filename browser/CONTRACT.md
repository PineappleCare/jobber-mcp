# Reviewed Jobber website contract

Inspected October 20, 2026 in the authenticated Williams website. Inspection
opened forms and cancelled without saving; no payment or property mutation was
performed. These observations establish form structure, not live write acceptance.

* Company settings `/accounts/edit` includes the active numeric `account_id` in
  inline configuration. Require exactly one distinct identity and match the
  pinned OAuth account's decoded ID. Never accept a display name as identity.
* Invoice `Collect Payment` opens `/payments/new?clientId=…&invoiceId=…`.
  The initial method charges a card. The offline section offers Cash, Cheque,
  E-transfer and Other (also card/PayPal choices, which this release excludes).
* The inspected E-transfer form labels are Payment method, Transaction Date,
  Reference #, and Details. It shows the selected invoice and its payment amount.
  `Save` records payment; `Save and Email Receipt` is a separate button. Only the
  exact `Save` control is allowed. Method-specific references fail closed if the
  expected control is absent. Positive acceptance of other methods is pending.
* Property More → Adjust map pin location opens
  `/properties/<numeric-id>/manually_geocode` in a new tab. Latitude and Longitude
  are labelled fields. Cancel links to the exact client/property detail URI.
  The form posts to `/properties/<id>` with `_method`, `property[geo_status]`,
  `property[latitude]`, `property[longitude]` and CSRF state. v1 deliberately uses
  the form's exact Save button; no private request endpoint is guessed or replayed.

The first implementation uses deterministic browser form actions for both writes.
A future HTTP adapter requires its own inspected request contract and fixtures;
transport errors never trigger an automatic switch from requests to clicks.

The public API lacks an invoice currency field in the pinned schema. This release
is restricted to the verified Canadian Williams account, using its CAD currency
convention, and displays CAD explicitly in approval; other countries/currencies
are blocked. This is not a general multi-currency inference.

Browser session state is independent of OAuth. The owner logs in through the SSO
viewer and presses Finish login. Stored auth is encrypted and never imported from
a developer workstation's browser profile. Operation payloads/results are also
encrypted. The viewer uses pinned noVNC 1.5.0 because the 1.6.0 npm CommonJS build
contains a top-level await that cannot be bundled correctly; noVNC source is
included in node_modules with its MPL-2.0 notices.

## Linux confinement

The Chromium sandbox remains enabled. Docker's standard AppArmor profile denies
`userns_create` on KT. The browser-specific policy preserves the Moby baseline
(moby/profiles commit 4b8214fc4971e06172938a1f1554ccff6647ee80,
Apache-2.0), adds explicit user namespaces and Unix sockets, and applies only to
this container. The pinned Playwright seccomp baseline adds `chroot` so Chromium
can chroot *inside* its user namespace even with ALL host capabilities dropped.
No SYS_ADMIN/SYS_CHROOT host capability, host IPC, privileged mode, unconfined
profile or `--no-sandbox` flag is used. Rollback keeps the profile while any
browser container uses it; removing an AppArmor profile from a running container
is not a rollback procedure.
