import { describe, expect, it } from 'vitest'
import { browserCommand } from '../browser'

describe('opening the viewer in a browser', () => {
  it('picks the launcher of the platform and hands it the address as one argument', () => {
    const url = 'http://127.0.0.1:4180/runs/11111111-2222-4333-8444-555555555555'
    expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] })
    expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] })
    // No cmd.exe in the way: rundll32 gets the URL verbatim, quoting rules do not apply.
    expect(browserCommand(url, 'win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] })
  })
})
