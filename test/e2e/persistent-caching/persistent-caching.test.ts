import { nextTestSetup } from 'e2e-utils'
import { waitFor } from 'next-test-utils'
import type { Playwright } from 'next-webdriver'

describe('persistent-caching', () => {
  const { skipped, next, isNextDev } = nextTestSetup({
    files: __dirname,
    skipDeployment: true,
  })

  // TODO: handle changed ports automatically when restarting the server
  function browserGet(browser: Playwright, href: string) {
    return browser.get(new URL(href, next.url).href)
  }

  if (skipped) {
    return
  }

  async function restartCycle() {
    await stop()
    await start()
  }

  async function stop() {
    if (isNextDev) {
      // Give Persistent Cache time to write to disk
      await waitFor(10000)
    }
    await next.stop()
  }

  async function start() {
    if (!isNextDev) {
      await next.build()
    }
    await next.start()
  }

  it('should persistent cache loaders', async () => {
    let appTimestamp: string, pagesTimestamp: string
    const browser = await next.browser('/')

    await browserGet(browser, '/')
    appTimestamp = await browser.elementByCss('main').text()

    await browserGet(browser, '/pages')
    pagesTimestamp = await browser.elementByCss('main').text()

    await restartCycle()

    await browserGet(browser, '/')
    // TODO Persistent Caching for webpack dev server is broken
    expect(await browser.elementByCss('main').text()).toBe(appTimestamp)

    await browserGet(browser, '/pages')
    // TODO Persistent Caching for webpack dev server is broken
    expect(await browser.elementByCss('main').text()).toBe(pagesTimestamp)
  })

  it('should allow to change files while stopped', async () => {
    const browser = await next.browser('/')
    expect(await browser.elementByCss('p').text()).toBe('hello world')

    await browserGet(browser, '/pages')
    expect(await browser.elementByCss('p').text()).toBe('hello world')

    await stop()

    await next.patchFile(
      'pages/pages.tsx',
      (content) => {
        return content.replace('hello world', 'hello persistent caching')
      },
      async () => {
        await next.patchFile(
          'app/page.tsx',
          (content) => {
            return content.replace('hello world', 'hello persistent caching')
          },
          async () => {
            await start()

            await browserGet(browser, '/')
            expect(await browser.elementByCss('p').text()).toBe(
              'hello persistent caching'
            )

            await browserGet(browser, '/pages')
            expect(await browser.elementByCss('p').text()).toBe(
              'hello persistent caching'
            )

            await stop()
          }
        )
      }
    )
    await start()
  })
})
