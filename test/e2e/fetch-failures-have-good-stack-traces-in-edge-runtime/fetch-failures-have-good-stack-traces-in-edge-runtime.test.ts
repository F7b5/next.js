import { nextTestSetup } from 'e2e-utils'
import webdriver from 'next-webdriver'
import { retry } from 'next-test-utils'
import stripAnsi from 'strip-ansi'

describe('fetch failures have good stack traces in edge runtime', () => {
  const { isTurbopack, next, isNextStart, isNextDev, skipped } = nextTestSetup({
    files: __dirname,
    // don't have access to runtime logs on deploy
    skipDeployment: true,
  })

  if (skipped) {
    return
  }

  it('when awaiting `fetch` using an unknown domain, stack traces are preserved', async () => {
    const outputIndex = next.cliOutput.length
    const browser = await webdriver(next.url, '/api/unknown-domain')

    if (isNextStart) {
      expect(next.cliOutput.slice(outputIndex)).toMatch(
        /at.+\/pages\/api\/unknown-domain.js/
      )
    } else if (isNextDev) {
      expect(stripAnsi(next.cliOutput.slice(outputIndex))).toContain(
        '' +
          '\n ⨯ Error [TypeError]: fetch failed' +
          '\n    at anotherFetcher (src/fetcher.js:6:15)' +
          '\n    at fetcher (src/fetcher.js:2:15)' +
          '\n    at UnknownDomainEndpoint (pages/api/unknown-domain.js:6:16)' +
          '\n  4 |' +
          '\n  5 | async function anotherFetcher(...args) {' +
          '\n> 6 |   return await fetch(...args)' +
          '\n    |               ^' +
          '\n  7 | }' +
          '\n  8 |' +
          // TODO(veil): Why double error?
          '\n ⨯ Error [TypeError]: fetch failed'
      )

      // TODO(veil): Why column off by one?
      await expect(browser).toDisplayRedbox(`
       {
         "description": "TypeError: fetch failed",
         "environmentLabel": null,
         "label": "Runtime Error",
         "source": "src/fetcher.js (6:16) @ anotherFetcher
       > 6 |   return await fetch(...args)
           |                ^",
         "stack": [
           "anotherFetcher src/fetcher.js (6:16)",
           "fetcher src/fetcher.js (2:16)",
           "UnknownDomainEndpoint pages/api/unknown-domain.js (6:${isTurbopack ? 15 : 16})",
         ],
       }
      `)
    }
  })

  it('when returning `fetch` using an unknown domain, stack traces are preserved', async () => {
    const outputIndex = next.cliOutput.length
    await webdriver(next.url, '/api/unknown-domain-no-await')

    await retry(() =>
      expect(stripAnsi(next.cliOutput.slice(outputIndex))).toContain(
        'Error: fetch failed'
      )
    )

    expect(stripAnsi(next.cliOutput.slice(outputIndex))).toContain(
      '' +
        '\nError: fetch failed' +
        // TODO(veil): Why no sourcemaps?
        '\n    at context.fetch (/'
    )
  })
})
