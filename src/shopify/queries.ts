/**
 * Bulk operation query. Constraints Shopify imposes on bulk queries:
 *   - exactly one root connection
 *   - no `first` / `last` on any connection
 *   - nested connections must use edges { node { ... } }
 * Results arrive as JSONL, one node per line, children carrying `__parentId`.
 */
export const BULK_PRODUCTS_QUERY = `
{
  products(query: "__QUERY__") {
    edges {
      node {
        __typename
        id
        handle
        title
        descriptionHtml
        vendor
        productType
        tags
        status
        onlineStoreUrl
        publishedAt
        isGiftCard
        category { id fullName }
        featuredMedia { preview { image { url altText } } }
        media { edges { node { ... on MediaImage { __typename image { url altText } } } } }
        metafields(namespace: "__NAMESPACE__") { edges { node { __typename namespace key value } } }
        variants {
          edges {
            node {
              __typename
              id
              sku
              barcode
              title
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
              inventoryPolicy
              taxable
              selectedOptions { name value }
              media { edges { node { ... on MediaImage { __typename image { url } } } } }
              inventoryItem { measurement { weight { unit value } } }
            }
          }
        }
      }
    }
  }
}
`.trim();

export function buildBulkQuery(opts: {
  includeDraft: boolean;
  requireOnlineStore: boolean;
  metafieldNamespace: string;
}): string {
  const clauses: string[] = [];
  clauses.push(opts.includeDraft ? "(status:active OR status:draft)" : "status:active");
  if (opts.requireOnlineStore) clauses.push("published_status:published");
  clauses.push("gift_card:false");

  return BULK_PRODUCTS_QUERY
    // The query string is embedded in a GraphQL string literal.
    .replace("__QUERY__", clauses.join(" AND ").replace(/"/g, '\\"'))
    .replace("__NAMESPACE__", opts.metafieldNamespace.replace(/[^a-zA-Z0-9_-]/g, ""));
}

export const BULK_RUN_MUTATION = `#graphql
  mutation CjFeedBulkStart($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status createdAt }
      userErrors { field message }
    }
  }
`;

export const BULK_BY_ID_QUERY = `#graphql
  query CjFeedBulkById($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        fileSize
        url
        partialDataUrl
        createdAt
        completedAt
        type
      }
    }
  }
`;

export const BULK_CANCEL_MUTATION = `#graphql
  mutation CjFeedBulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Only used to recover when a previous run left a bulk operation in flight.
 * Deprecated in favour of `bulkOperations`, but that connection has no `type`
 * filter, and this is the narrowest query for the one thing we need here.
 */
export const CURRENT_BULK_QUERY = `#graphql
  query CjFeedCurrentBulk {
    currentBulkOperation(type: QUERY) {
      id
      status
      createdAt
    }
  }
`;
