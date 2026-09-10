import { describe, expect, it } from 'vitest'
import { parseReadinessLine, splitLines } from '../src/runtime/server.ts'
import { firstSessionCookie } from '../src/runtime/session.ts'

describe('parseReadinessLine', () => {
  it('reads the port and launch token from the supervisor line', () => {
    expect(parseReadinessLine('dsh web: http://127.0.0.1:51234/?token=abc'))
      .toEqual({ port: 51234, launchToken: 'abc' })
  })

  it('ignores the LAN suffix, since the extension only talks to loopback', () => {
    expect(parseReadinessLine('dsh web: http://127.0.0.1:3080/?token=xyz (LAN: http://10.0.0.2:3080/?token=xyz)'))
      .toEqual({ port: 3080, launchToken: 'xyz' })
  })

  it('rejects the browser-handoff line that follows it', () => {
    expect(parseReadinessLine('dsh web: opening the default browser; pass --no-open to disable'))
      .toBeUndefined()
  })

  it('rejects an unrelated log line', () => {
    expect(parseReadinessLine('web-app: something else')).toBeUndefined()
  })

  it('rejects a URL carrying no token, which would fail the handshake later', () => {
    expect(parseReadinessLine('dsh web: http://127.0.0.1:3080/')).toBeUndefined()
  })
})

describe('splitLines', () => {
  it('withholds a partial line until its newline arrives', () => {
    expect(splitLines('one\ntwo\nthr')).toEqual({ lines: ['one', 'two'], rest: 'thr' })
  })

  it('emits nothing while no line is complete', () => {
    expect(splitLines('dsh web: http')).toEqual({ lines: [], rest: 'dsh web: http' })
  })
})

describe('firstSessionCookie', () => {
  it('keeps only the name=value pair, dropping the attributes', () => {
    expect(firstSessionCookie(['dsh-auth-xyz=v1.body.sig; Path=/; HttpOnly; SameSite=Strict']))
      .toBe('dsh-auth-xyz=v1.body.sig')
  })

  it('skips cookies that are not the browser session', () => {
    expect(firstSessionCookie(['other=1; Path=/', 'dsh-auth-a=b; Path=/'])).toBe('dsh-auth-a=b')
  })

  it('reports absence rather than guessing', () => {
    expect(firstSessionCookie([])).toBeUndefined()
  })
})
