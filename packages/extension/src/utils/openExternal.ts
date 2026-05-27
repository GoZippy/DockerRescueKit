import { createDockerDesktopClient } from '@docker/extension-api-client'

// Lazily-resolved ddClient. In extension transport the iframe lives inside
// Docker Desktop and ddClient is available; in tcp/browser transport
// it's still constructible but most ddClient.* surfaces are no-ops, so we
// fall back to window.open.
let _client: ReturnType<typeof createDockerDesktopClient> | null = null
function client() {
  if (!_client) _client = createDockerDesktopClient()
  return _client
}

const isExtensionMode = (): boolean =>
  import.meta.env.VITE_TRANSPORT === 'extension'

/**
 * Open a URL in the user's host browser.
 *
 * In a Docker Desktop extension iframe, plain `<a target="_blank">` is
 * silently blocked — the only correct surface is
 * `ddClient.host.openExternal()`. Outside Desktop we fall back to
 * `window.open`.
 */
export function openExternal(url: string): void {
  try {
    if (isExtensionMode()) {
      client().host.openExternal(url)
      return
    }
  } catch {
    // fallthrough to window.open
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Deep-link to Docker Desktop's Marketplace tab, ideally focused on a
 * specific extension. `extensionId` should be the canonical Hub repo,
 * e.g. `gozippy/dockerrescuekit`.
 *
 * Docker Desktop's `desktopUI.navigate` API accepts the route
 * `marketplace?extensionId=<id>` to pre-select an extension. If we're not
 * running inside Desktop (dev/browser), fall back to opening the Hub
 * tags page in the host browser.
 */
export function openMarketplace(extensionId = 'gozippy/dockerrescuekit'): void {
  try {
    if (isExtensionMode()) {
      const ui: any = (client() as any).desktopUI
      if (ui && typeof ui.navigate === 'function') {
        ui.navigate(`marketplace?extensionId=${encodeURIComponent(extensionId)}`)
        return
      }
    }
  } catch {
    // fallthrough
  }
  openExternal(`https://hub.docker.com/r/${extensionId}`)
}
