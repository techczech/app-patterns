export interface UpdateIdentity {
  /** Fixed product name, never a version or a per-install value. Used as the User-Agent. */
  appName: string;
  /** An HTTPS URL with no query, fragment or credentials. All feed links must use this origin. */
  feedUrl: string;
  storeName?: string;
  storeUrl?: string;
}
