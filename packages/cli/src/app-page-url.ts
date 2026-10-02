/**
 * Where an app's page lives in the web app (ORI-2342): `/preview/<app id>`,
 * the route in apps/web/app/preview/[id]/page.tsx. `orizu apps list`,
 * `orizu apps update` and the hosted agent's prompt build their links from
 * here. `orizu apps create` prints the link the server returns instead.
 */
export function appPagePath(appId: string): string {
  return `/preview/${appId}`
}

export function appPageUrl(baseUrl: string, appId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${appPagePath(encodeURIComponent(appId))}`
}
