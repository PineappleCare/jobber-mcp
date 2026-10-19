# Verified unscheduled one-off creation

Verified on October 7, 2026 against API version `2025-04-16`, using an explicitly
authorized internal property in the existing account. The mutation returned a
job, and an independent read returned `jobType: ONE_OFF`, fixed-price billing
on completion, null job dates, and empty visit/line-item connections. No separate
Jobber account was created. Private probe evidence remains outside source control.

Both `2025-04-16` and `2026-09-25` live introspection expose `jobCreate` with
`JobCreateAttributes`, and no explicit job-type selector. Absence of such a
selector is not evidence that one-off creation is unsupported. Existing jobs
helped identify the candidate below; only the mutation and readback proved it.

```graphql
mutation CreateOneOff($input: JobCreateAttributes!) {
  jobCreate(input: $input) {
    job { id jobType billingType }
    userErrors { message path }
  }
}
```

```json
{
  "input": {
    "propertyId": "reviewed-account-property-id",
    "title": "Reviewed one-off work",
    "instructions": "Reviewed instructions",
    "lineItems": [],
    "invoicing": {
      "invoicingType": "FIXED_PRICE",
      "invoicingSchedule": "ON_COMPLETION"
    },
    "scheduling": { "createVisits": false, "notifyTeam": false },
    "allowReviewRequest": false
  }
}
```

Omit timeframe and both recurrence fields. Do not infer that every other billing,
date or recurrence combination produces the same type. The connector exposes
only this verified one-off billing combination initially. The newer schema check
does not constitute positive write acceptance on that version; the API version
remains unchanged.

Use separate approval-required visit tools for requested scheduling. Creation
does not convert existing jobs. Native tasks remain the tool for non-billable
errands. Hermes must review explicit resolved type/billing choices, destination,
title, instructions and all line items before dispatch, even though the connector
provides defaults to other clients. WhatsApp cannot invoke these writes.

Tests cover source relationships, bounded duplicate scanning, incompatible
inputs, explicit recurring requests, financial/text readback mismatches,
returned IDs alongside errors, and timeout reconciliation without mutation replay.
Mocked cases are not additional live write acceptance. The initial live probe
establishes unscheduled creation; multi-visit behavior is exercised with fixture
operations rather than additional production scheduling effects.

Official references: [GraphQL API request and error semantics](https://developer.getjobber.com/docs/using_jobbers_api/api_queries_and_mutations/),
[one-off job behavior](https://help.getjobber.com/en/articles/create-a-one-off-job/),
and [job types and the inability to switch an existing job's type](https://help.getjobber.com/en/articles/job-basics/).
