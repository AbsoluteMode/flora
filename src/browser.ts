import { spawn } from 'node:child_process'

/** The launcher that hands a URL to the default browser on this platform. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // rundll32 takes the URL as one argument — no cmd.exe quoting to get wrong.
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Best effort: the address is printed regardless, so a browser that cannot be
 * started (a headless box, no launcher on the PATH) is reported, not fatal.
 * The launcher is detached — the viewer must not wait on it.
 */
export function openInBrowser(url: string, onFail?: (reason: string) => void): void {
  const { command, args } = browserCommand(url)
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', (err) => onFail?.(err.message))
    child.unref()
  } catch (err) {
    onFail?.((err as Error).message)
  }
}
