export const FIND_CLIENT_QUERY = /* GraphQL */ `
  query FindClient($searchTerm: String, $first: Int!, $after: String) {
    clients(searchTerm: $searchTerm, first: $first, after: $after) {
      totalCount
      nodes {
        id
        name
        companyName
        emails {
          address
          primary
        }
        phones {
          number
          primary
        }
        billingAddress {
          street1
          street2
          city
          province
          postalCode
          country
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const CLIENT_HISTORY_QUERY = /* GraphQL */ `
  query ClientHistory(
    $clientId: EncodedId!
    $first: Int!
    $afterJobs: String
    $afterQuotes: String
    $afterInvoices: String
    $paymentsFirst: Int!
  ) {
    client(id: $clientId) {
      id
      name
      jobs(first: $first, after: $afterJobs) {
        totalCount
        nodes {
          id
          jobNumber
          title
          jobStatus
          total
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      quotes(first: $first, after: $afterQuotes) {
        totalCount
        nodes {
          id
          quoteNumber
          title
          quoteStatus
          amounts {
            total
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      invoices(first: $first, after: $afterInvoices) {
        totalCount
        nodes {
          id
          invoiceNumber
          invoiceStatus
          amounts {
            total
          }
          dueDate
          paymentRecords(first: $paymentsFirst) {
            totalCount
            nodes {
              id
              amount
              paidAt: entryDate
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const CLIENT_HISTORY_PAYMENTS_PAGE_QUERY = /* GraphQL */ `
  query ClientHistoryPaymentsPage($invoiceId: EncodedId!, $first: Int!, $after: String) {
    invoice(id: $invoiceId) {
      id
      invoiceNumber
      client {
        id
      }
      paymentRecords(first: $first, after: $after) {
        totalCount
        nodes {
          id
          amount
          paidAt: entryDate
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const OVERDUE_INVOICES_QUERY = /* GraphQL */ `
  query OverdueInvoices($first: Int!, $after: String) {
    invoices(
      first: $first
      after: $after
      filter: { status: past_due }
      sort: [{ key: DUE_DATE, direction: ASCENDING }]
    ) {
      totalCount
      nodes {
        id
        invoiceNumber
        client {
          id
          name
        }
        amounts {
          total
          invoiceBalance
        }
        dueDate
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const QUOTES_OUTSTANDING_QUERY = /* GraphQL */ `
  query QuotesOutstanding($first: Int!, $after: String) {
    quotes(first: $first, after: $after, filter: { status: awaiting_response }) {
      totalCount
      nodes {
        id
        quoteNumber
        title
        client {
          id
          name
        }
        amounts {
          total
        }
        createdAt
        quoteStatus
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const JOBS_SUMMARY_QUERY = /* GraphQL */ `
  query JobsSummary($first: Int!, $after: String, $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
    jobs(first: $first, after: $after, filter: { createdAt: { after: $from, before: $to } }) {
      totalCount
      nodes {
        id
        jobStatus
        total
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const REVENUE_SUMMARY_QUERY = /* GraphQL */ `
  query RevenueSummary($first: Int!, $after: String, $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
    invoices(first: $first, after: $after, filter: { status: paid, issuedDate: { after: $from, before: $to } }) {
      totalCount
      nodes {
        id
        amounts {
          total
        }
        issuedDate
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const SCHEDULE_LOOKUP_QUERY = /* GraphQL */ `
  query ScheduleLookup($first: Int!, $after: String, $from: ISO8601DateTime!, $to: ISO8601DateTime!) {
    scheduledItems(
      first: $first
      after: $after
      filter: { occursWithin: { startAt: $from, endAt: $to }, schedulingAspects: [ASSIGNMENTS] }
    ) {
      totalCount
      nodes {
        __typename
        ... on Visit {
          id
          title
          visitStatus
          startAt
          endAt
          client {
            id
            name
          }
        }
        ... on Assessment {
          id
          title
          startAt
          endAt
          client {
            id
            name
          }
          isComplete
          completedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const REQUESTS_INBOX_QUERY = /* GraphQL */ `
  query RequestsInbox($first: Int!, $after: String, $unscheduledAfter: String) {
    newRequests: requests(first: $first, after: $after, filter: { status: new }) {
      totalCount
      nodes {
        id
        title
        requestStatus
        client {
          id
          name
        }
        createdAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    unscheduledRequests: requests(first: $first, after: $unscheduledAfter, filter: { status: unscheduled }) {
      totalCount
      nodes {
        id
        title
        requestStatus
        client {
          id
          name
        }
        createdAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const ACCOUNT_ID_QUERY = /* GraphQL */ `
  query AccountId {
    account {
      id
    }
  }
`;

// These mutations deliberately request only the small, stable response shape
// needed by their tools. They are not an arbitrary GraphQL escape hatch.
export const CREATE_CLIENT_MUTATION = /* GraphQL */ `
  mutation CreateClient($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client {
        id
        name
        companyName
      }
      userErrors {
        message
        path
      }
    }
  }
`;

export const UPDATE_CLIENT_COMPANY_NAME_MUTATION = /* GraphQL */ `
  mutation UpdateClientCompanyName($clientId: EncodedId!, $input: ClientEditInput!) {
    clientEdit(clientId: $clientId, input: $input) {
      client {
        id
        name
        companyName
      }
      userErrors {
        message
        path
      }
    }
  }
`;
