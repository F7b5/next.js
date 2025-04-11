import {
  chromium,
  webkit,
  firefox,
  Browser,
  BrowserContext,
  Page,
  ElementHandle,
  devices,
  Locator,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from 'playwright'
import path from 'path'
import { getCurrentTestTraceOutputDir } from '../test-trace-output'

type EventType = 'request' | 'response'

export type BrowserOptions = {
  browserName: string
  headless: boolean
  enableTracing: boolean
}

export type BrowserContextOptions = {
  locale: string
  javaScriptEnabled: boolean
  ignoreHTTPSErrors: boolean
  userAgent: string | undefined
  deviceName: string | undefined
}

export class SharedPlaywrightState {
  private constructor(
    public browser: Browser,
    public defaultContext: BrowserContextWrapper,
    public browserOptions: BrowserOptions
  ) {}

  static async create(
    browserOptions: BrowserOptions,
    contextOptions: BrowserContextOptions
  ): Promise<SharedPlaywrightState> {
    const { browserName, headless } = browserOptions
    const browser = await launchBrowser(browserName, { headless })

    const tracingEnabled = browserOptions.enableTracing
    const defaultContext = await BrowserContextWrapper.create(
      browser,
      contextOptions,
      tracingEnabled
    )
    return new SharedPlaywrightState(browser, defaultContext, browserOptions)
  }

  async canReuseBrowser(browserOptions: BrowserOptions) {
    // if a browser configuration option changed, we have to recreate the whole state.
    return !SharedPlaywrightState.optionChanged(
      this.browserOptions,
      browserOptions
    )
  }

  async updateDefaultBrowserContext(newOptions: BrowserContextOptions) {
    // if a browser context configuration option changed, we have to recreate the context.
    if (
      SharedPlaywrightState.optionChanged(
        this.defaultContext.options,
        newOptions
      )
    ) {
      await this.defaultContext.close()
      this.defaultContext = await BrowserContextWrapper.create(
        this.browser,
        newOptions,
        this.tracingEnabled()
      )
    }
    return this.defaultContext
  }

  private static optionChanged<T extends Record<string, any>>(
    prev: T,
    current: T
  ): boolean {
    for (const [key, prevValue] of Object.entries(prev)) {
      const currentValue = current[key]
      if (currentValue !== prevValue) {
        return true
      }
    }
    return false
  }

  async close() {
    await this.closeDefaultContext()
    await this.browser.close()
    this.browser = null!
  }

  async closeDefaultContext() {
    await this.defaultContext.close().finally(() => {
      this.defaultContext = null!
    })
  }

  tracingEnabled() {
    return this.browserOptions.enableTracing
  }
}

export class BrowserContextWrapper {
  private _isClosed = false
  private closePromise: Promise<void> | null = null
  isClosed() {
    return this._isClosed
  }

  private constructor(
    public context: BrowserContext,
    public options: BrowserContextOptions,
    public tracer: Tracer
  ) {}

  static async create(
    browser: Browser,
    options: BrowserContextOptions,
    tracingEnabled: boolean
  ): Promise<BrowserContextWrapper> {
    const {
      locale,
      javaScriptEnabled,
      ignoreHTTPSErrors,
      userAgent,
      deviceName,
    } = options

    type Devices = typeof import('playwright').devices
    type Device = Devices[keyof Devices]
    let device: Device | undefined

    if (deviceName !== undefined) {
      device = devices[deviceName]
      if (!device) {
        throw new Error(`Invalid Playwright device name ${deviceName}`)
      }
    }

    const context = await browser.newContext({
      locale,
      javaScriptEnabled,
      ignoreHTTPSErrors,
      ...(userAgent ? { userAgent } : {}),
      ...device,
    })

    const tracer = tracingEnabled ? await Tracer.start(context) : null

    return new BrowserContextWrapper(context, options, tracer)
  }

  async reset() {
    // TODO: clean up context before reusing it
  }

  async close() {
    if (this.isClosed()) {
      return
    } else if (this.closePromise) {
      return this.closePromise
    }

    this.closePromise = (async () => {
      if (this.tracer) {
        await this.tracer.close()
      }
      await this.reset()
      await this.context.close()

      this._isClosed = true
      this.closePromise = null
    })()
    return this.closePromise
  }
}

type StartedTraceInfo = {
  id: number
  name: string
}

type TraceState =
  | { kind: 'initial' }
  | { kind: 'starting'; info: StartedTraceInfo; promise: Promise<void> }
  | { kind: 'started'; info: StartedTraceInfo }
  | { kind: 'ending'; info: StartedTraceInfo; promise: Promise<void> }
  | { kind: 'ended' }

// This is global so that it's shared for all browsers created in a test file
// (even if the shared playwright state gets recreated)
let nextTraceId = 0

const moduleInitializationTime = Date.now()

class Tracer {
  private traceState: TraceState = { kind: 'initial' }

  private constructor(private context: BrowserContext) {}

  static async start(context: BrowserContext) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    })
    return new Tracer(context)
  }

  async close() {
    // if the trace didn't get ended normally for some reason, we should end it here to avoid dropping it.
    const { traceState } = this
    if (traceState.kind !== 'initial' && traceState.kind !== 'ended') {
      try {
        await this.ensureCurrentTraceEnded()
      } catch (err) {
        require('console').warn(
          `Failed to end playwright trace '${traceState.info.name}' while tearing down`,
          err
        )
      }
    }

    try {
      await this.context.tracing.stop()
    } catch (e) {
      require('console').warn('Failed to teardown playwright tracing', e)
    }
  }

  async startTrace(rawName: string): Promise<void> {
    const traceId = nextTraceId++
    const name = `${traceId}. ${rawName}`

    const { traceState } = this
    if (traceState.kind !== 'initial' && traceState.kind !== 'ended') {
      // This shouldn't ever happen. We're going to error, but first, make sure we're in a consistent state
      // to prevent cascading errors in other tests.
      await this.ensureCurrentTraceEnded()
      const stateDescription =
        traceState.kind === 'started' ? 'still running' : traceState.kind
      throw new Error(
        `Cannot start a new trace '${name}' while the previous trace '${traceState.info.name}' is ${stateDescription}`
      )
    }

    const info: StartedTraceInfo = {
      id: traceId,
      name,
    }

    try {
      this.traceState = {
        kind: 'starting',
        info,
        promise: this.context.tracing.startChunk({
          title: name,
        }),
      }
      await this.traceState.promise
      this.traceState = { kind: 'started', info }
    } catch (err) {
      this.traceState = { kind: 'initial' }
      throw new Error(`Failed to start playwright trace '${name}'`, {
        cause: err,
      })
    }
  }

  async endTrace() {
    const { traceState } = this
    if (traceState.kind !== 'started') {
      throw new Error('Cannot call endTrace with no active trace')
    }

    const fileName = this.generateTraceFilename(traceState.info)
    const traceOutputDir = getCurrentTestTraceOutputDir()
    const traceOutputPath = path.join(traceOutputDir, fileName)

    try {
      this.traceState = {
        kind: 'ending',
        info: traceState.info,
        promise: this.context.tracing.stopChunk({ path: traceOutputPath }),
      }
      await this.traceState.promise
    } catch (err) {
      throw new Error(
        `An error occurred while stopping playwright trace '${traceState.info.name}'`,
        { cause: err }
      )
    } finally {
      this.traceState = { kind: 'ended' }
    }
  }

  private async ensureCurrentTraceEnded() {
    const { traceState } = this
    if (traceState.kind === 'starting') {
      await traceState.promise
      if (this.traceState.kind === 'started') {
        await this.endTrace()
      }
    } else if (traceState.kind === 'started') {
      await this.endTrace()
    } else if (traceState.kind === 'ending') {
      // finish shutdown
      await traceState.promise
    }
  }

  private generateTraceFilename(traceInfo: StartedTraceInfo) {
    // Make sure that the filename doesn't exceed 255 characters,
    // which is a common filename length limit.
    // (exceeding it causes an ENAMETOOLONG when saving the trace)
    // https://stackoverflow.com/a/54742403
    const maxTotalLength = 255

    const prefix = `pw-${moduleInitializationTime}-${traceInfo.id}-`
    const suffix = `-${Date.now()}.zip`

    const maxInfixLength = maxTotalLength - (prefix.length + suffix.length)
    const infix = encodeURIComponent(traceInfo.name).slice(0, maxInfixLength)
    return prefix + infix + suffix
  }
}

async function launchBrowser(
  browserName: string,
  launchOptions: Record<string, any>
) {
  if (browserName === 'safari') {
    return await webkit.launch(launchOptions)
  } else if (browserName === 'firefox') {
    return await firefox.launch({
      ...launchOptions,
      firefoxUserPrefs: {
        ...launchOptions.firefoxUserPrefs,
        // The "fission.webContentIsolationStrategy" pref must be
        // set to 1 on Firefox due to the bug where a new history
        // state is pushed on a page reload.
        // See https://github.com/microsoft/playwright/issues/22640
        // See https://bugzilla.mozilla.org/show_bug.cgi?id=1832341
        'fission.webContentIsolationStrategy': 1,
      },
    })
  } else {
    return await chromium.launch({
      devtools: !launchOptions.headless,
      ...launchOptions,
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    })
  }
}

const defaultTimeout = process.env.NEXT_E2E_TEST_TIMEOUT
  ? parseInt(process.env.NEXT_E2E_TEST_TIMEOUT, 10)
  : // In development mode, compilation can take longer due to lower CPU
    // availability in GitHub Actions.
    60 * 1000

interface ElementHandleExt extends ElementHandle {
  getComputedCss(prop: string): Promise<string>
  text(): Promise<string>
}

type PageLog = { source: string; message: string; args: unknown[] }

type PageState = {
  page: Page
  logs: Array<Promise<PageLog> | PageLog>
  websocketFrames: Array<{ payload: string | Buffer }>
}

export class Playwright<TCurrent = any> {
  constructor(
    private sharedState: SharedPlaywrightState,
    private context: BrowserContextWrapper
  ) {}

  private _pageState: PageState | null = null

  private getReadyState(): PageState {
    if (this._pageState === null) {
      throw new Error('No page available')
    }
    return this._pageState
  }

  private currentPage(): Page {
    const state = this.getReadyState()
    return state.page
  }

  private eventCallbacks: Record<EventType, Set<(...args: any[]) => void>> = {
    request: new Set(),
    response: new Set(),
  }

  on(
    event: 'request',
    cb: (request: PlaywrightRequest) => void | Promise<void>
  ): void
  on(
    event: 'response',
    cb: (request: PlaywrightResponse) => void | Promise<void>
  ): void
  on(event: EventType, cb: (...args: any[]) => void) {
    if (!this.eventCallbacks[event]) {
      throw new Error(
        `Invalid event passed to browser.on, received ${event}. Valid events are ${Object.keys(
          this.eventCallbacks
        )}`
      )
    }
    this.eventCallbacks[event]?.add(cb)
  }

  off(
    event: 'request',
    cb: (request: PlaywrightRequest) => void | Promise<void>
  ): void
  off(
    event: 'response',
    cb: (request: PlaywrightResponse) => void | Promise<void>
  ): void
  off(event: EventType, cb: (...args: any[]) => void) {
    this.eventCallbacks[event]?.delete(cb)
  }

  async close(): Promise<void> {
    if (!this._pageState) {
      return
    }
    await this.context.tracer?.endTrace()
    await this.reset()
  }

  async reset() {
    const state = this._pageState
    if (!state) {
      return
    }
    const { page } = state
    if (!page.isClosed()) {
      await page.close()
    }
    this._pageState = null

    // clean-up existing pages
    const { context } = this
    await Promise.all(
      context.context.pages().map(async (oldPage) => {
        if (!oldPage.isClosed()) {
          await oldPage.close()
        }
      })
    )
  }

  async get(url: string): Promise<void> {
    const page = this.currentPage()
    await page.goto(url)
  }

  async loadPage(
    url: string,
    opts?: {
      disableCache?: boolean
      cpuThrottleRate?: number
      pushErrorAsConsoleLog?: boolean
      beforePageLoad?: (page: Page) => void
      waitHydration?: boolean
      retryWaitHydration?: boolean
    }
  ) {
    if (this._pageState) {
      // loadPage may be called multiple times within a single test.
      // in that case, we need to reset.
      await this.reset()
    } else {
      // if this is the first time loadPage is called in this test, start a trace.
      // otherwise, we should already have a trace running.

      // omit the host from the trace name if it's `localhost[:port]`, because that's not useful.
      const urlObj = new URL(url)
      const traceName =
        urlObj.hostname === 'localhost'
          ? urlObj.pathname + urlObj.search + urlObj.hash
          : url

      await this.context.tracer?.startTrace(traceName)
    }

    const { context } = this

    const setupPage = async (pageState: PageState) => {
      const { page, logs: pageLogs, websocketFrames } = pageState

      page.setDefaultTimeout(defaultTimeout)
      page.setDefaultNavigationTimeout(defaultTimeout)

      page.on('console', (msg) => {
        console.log('browser log:', msg)
        pageLogs.push(
          Promise.all(
            msg.args().map((handle) => handle.jsonValue().catch(() => {}))
          ).then((args) => ({ source: msg.type(), message: msg.text(), args }))
        )
      })
      page.on('crash', () => {
        console.error('page crashed')
      })
      page.on('pageerror', (error) => {
        console.error('page error', error)

        if (opts?.pushErrorAsConsoleLog) {
          pageLogs.push({
            source: 'error',
            message: error.message,
            args: [],
          })
        }
      })
      page.on('request', (req) => {
        this.eventCallbacks.request.forEach((cb) => cb(req))
      })
      page.on('response', (res) => {
        this.eventCallbacks.response.forEach((cb) => cb(res))
      })

      if (opts?.disableCache) {
        // TODO: this doesn't seem to work (dev tools does not check the box as expected)
        const session = await context.context.newCDPSession(page)
        session.send('Network.setCacheDisabled', { cacheDisabled: true })
      }

      if (opts?.cpuThrottleRate) {
        const session = await context.context.newCDPSession(page)
        // https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate
        session.send('Emulation.setCPUThrottlingRate', {
          rate: opts.cpuThrottleRate,
        })
      }

      page.on('websocket', (ws) => {
        if (this.sharedState.tracingEnabled()) {
          page
            .evaluate(`console.log('connected to ws at ${ws.url()}')`)
            .catch(() => {})

          ws.on('close', () =>
            page
              .evaluate(`console.log('closed websocket ${ws.url()}')`)
              .catch(() => {})
          )
        }
        ws.on('framereceived', (frame) => {
          websocketFrames.push({ payload: frame.payload })

          if (this.sharedState.tracingEnabled()) {
            page
              .evaluate(`console.log('received ws message ${frame.payload}')`)
              .catch(() => {})
          }
        })
      })

      opts?.beforePageLoad?.(page)
    }

    const newPageState: PageState = {
      page: await context.context.newPage(),
      logs: [],
      websocketFrames: [],
    }

    await setupPage(newPageState)
    this._pageState = newPageState

    await newPageState.page.goto(url, { waitUntil: 'load' })

    const waitHydration = opts?.waitHydration ?? true
    if (waitHydration && this.context.options.javaScriptEnabled) {
      await this.waitForHydration(opts?.retryWaitHydration)
    }
  }

  async waitForHydration(retry = false) {
    const page = this.currentPage()

    // Wait for application to hydrate
    console.log(`\n> Waiting hydration for ${page.url()}\n`)

    const checkHydrated = async () => {
      await this.evalAsync(function () {
        var callback = arguments[arguments.length - 1]

        // if it's not a Next.js app return
        if (
          !document.documentElement.innerHTML.includes('__NEXT_DATA__') &&
          // @ts-ignore next exists on window if it's a Next.js page.
          typeof ((window as any).next && (window as any).next.version) ===
            'undefined'
        ) {
          console.log('Not a next.js page, resolving hydrate check')
          callback()
        }

        // TODO: should we also ensure router.isReady is true
        // by default before resolving?
        if ((window as any).__NEXT_HYDRATED) {
          console.log('Next.js page already hydrated')
          callback()
        } else {
          var timeout = setTimeout(callback, 10 * 1000)
          ;(window as any).__NEXT_HYDRATED_CB = function () {
            clearTimeout(timeout)
            console.log('Next.js hydrate callback fired')
            callback()
          }
        }
      })
    }

    try {
      await checkHydrated()
    } catch (err) {
      if (retry) {
        // re-try in case the page reloaded during check
        await new Promise((resolve) => setTimeout(resolve, 2000))
        await checkHydrated()
      } else {
        console.error('failed to check hydration')
        throw err
      }
    }

    console.log(`\n> Hydration complete for ${page.url()}\n`)
  }

  back(options?: Parameters<Page['goBack']>[0]) {
    const page = this.currentPage()
    return this.chain(async () => {
      await page.goBack(options)
    })
  }
  forward(options?: Parameters<Page['goForward']>[0]) {
    const page = this.currentPage()
    return this.chain(async () => {
      await page.goForward(options)
    })
  }
  refresh() {
    const page = this.currentPage()
    return this.chain(async () => {
      await page.reload()
    })
  }
  setDimensions({ width, height }: { height: number; width: number }) {
    const page = this.currentPage()
    return this.chain(() => page.setViewportSize({ width, height }))
  }
  addCookie(opts: { name: string; value: string }) {
    const { context } = this
    const page = this.currentPage()
    return this.chain(async () =>
      context.context.addCookies([
        {
          path: '/',
          domain: await page.evaluate('window.location.hostname'),
          ...opts,
        },
      ])
    )
  }
  deleteCookies() {
    const { context } = this
    return this.chain(async () => context.context.clearCookies())
  }

  focusPage() {
    const page = this.currentPage()
    return this.chain(() => page.bringToFront())
  }

  private wrapElement(el: ElementHandle, selector: string): ElementHandleExt {
    const page = this.currentPage()
    function getComputedCss(prop: string) {
      return page.evaluate(
        function (args) {
          const style = getComputedStyle(document.querySelector(args.selector))
          return style[args.prop] || null
        },
        { selector, prop }
      )
    }

    return Object.assign(el, {
      selector,
      getComputedCss,
      text: () => el.innerText(),
    })
  }

  elementByCss(selector: string) {
    return this.waitForElementByCss(selector, 5_000)
  }

  elementById(id: string) {
    return this.elementByCss(`#${id}`)
  }

  getValue(this: Playwright<ElementHandleExt>) {
    return this.chain((el: ElementHandleExt) => el.inputValue())
  }

  text(this: Playwright<ElementHandleExt>) {
    return this.chain((el: ElementHandleExt) => el.innerText())
  }

  type(this: Playwright<ElementHandleExt>, text: string) {
    return this.chain((el: ElementHandleExt) => el.type(text))
  }

  moveTo(this: Playwright<ElementHandleExt>) {
    return this.chain((el: ElementHandleExt) => {
      return el.hover().then(() => el)
    })
  }

  async getComputedCss(this: Playwright<ElementHandleExt>, prop: string) {
    return this.chain((el: ElementHandleExt) => {
      return el.getComputedCss(prop)
    })
  }

  async getAttribute(this: Playwright<ElementHandleExt>, attr: string) {
    return this.chain((el: ElementHandleExt) => el.getAttribute(attr))
  }

  hasElementByCssSelector(selector: string) {
    return this.eval<boolean>(`!!document.querySelector('${selector}')`)
  }

  keydown(key: string) {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.keyboard.down(key).then(() => el)
    })
  }

  keyup(key: string) {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.keyboard.up(key).then(() => el)
    })
  }

  click(this: Playwright<ElementHandleExt>) {
    return this.chain((el) => {
      return el.click().then(() => el)
    })
  }

  touchStart(this: Playwright<ElementHandleExt>) {
    return this.chain((el) => {
      return el.dispatchEvent('touchstart').then(() => el)
    })
  }

  elementsByCss(selector: string) {
    const page = this.currentPage()
    return this.chain(() =>
      page.$$(selector).then((els) => {
        return els.map((el) => {
          const origGetAttribute = el.getAttribute.bind(el)
          el.getAttribute = (name) => {
            // ensure getAttribute defaults to empty string to
            // match selenium
            return origGetAttribute(name).then((val) => val || '')
          }
          return el
        })
      })
    )
  }

  waitForElementByCss(selector: string, timeout = 10_000) {
    const page = this.currentPage()
    return this.chain(() => {
      return page
        .waitForSelector(selector, { timeout, state: 'attached' })
        .then(async (el) => {
          // it seems selenium waits longer and tests rely on this behavior
          // so we wait for the load event fire before returning
          await page.waitForLoadState()
          return this.wrapElement(el, selector)
        })
    })
  }

  waitForCondition(snippet: string, timeout?: number) {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.waitForFunction(snippet, { timeout }).then(() => el)
    })
  }

  eval<T = any>(fn: any, ...args: any[]) {
    const page = this.currentPage()
    return this.chain(() =>
      page
        .evaluate(fn, ...args)
        .catch((err) => {
          console.error('eval error:', err)
          return null
        })
        .then(async (val) => {
          await page.waitForLoadState()
          return val as T
        })
    )
  }

  async evalAsync<T = any>(fn: any) {
    const page = this.currentPage()

    if (typeof fn === 'function') {
      fn = fn.toString()
    }

    if (fn.includes(`var callback = arguments[arguments.length - 1]`)) {
      fn = `(function() {
        return new Promise((resolve, reject) => {
          const origFunc = ${fn}
          try {
            origFunc(resolve)
          } catch (err) {
            reject(err)
          }
        })
      })()`
    }

    return page.evaluate<T>(fn).catch(() => null)
  }

  async log<T extends boolean = false>(options?: { includeArgs?: T }) {
    const state = this.getReadyState()
    return this.chain(
      () =>
        options?.includeArgs
          ? Promise.all(state.logs)
          : Promise.all(state.logs).then((logs) =>
              logs.map(({ source, message }) => ({ source, message }))
            )
      // TODO: Starting with TypeScript 5.8 we might not need this type cast.
    ) as Promise<
      T extends true
        ? { source: string; message: string; args: unknown[] }[]
        : { source: string; message: string }[]
    >
  }

  async websocketFrames() {
    const state = this.getReadyState()
    return this.chain(() => state.websocketFrames)
  }

  async url() {
    const page = this.currentPage()
    return this.chain(() => page.url())
  }

  async waitForIdleNetwork() {
    const page = this.currentPage()
    return this.chain((el) => {
      return page.waitForLoadState('networkidle').then(() => el)
    })
  }

  locateRedbox(): Locator {
    const page = this.currentPage()
    return page.locator(
      'nextjs-portal [aria-labelledby="nextjs__container_errors_label"]'
    )
  }

  locateDevToolsIndicator(): Locator {
    const page = this.currentPage()
    return page.locator('nextjs-portal [data-nextjs-dev-tools-button]')
  }

  private promise?: Promise<TCurrent>;

  // necessary for the type of the function below
  readonly [Symbol.toStringTag]: string = 'Playwright'

  private chain<TNext>(
    this: Playwright<TCurrent>,
    nextCall: (current: TCurrent) => TNext | Promise<TNext>
  ): Playwright<TNext> & Promise<TNext> {
    const syncError = new Error('next-browser-base-chain-error')
    const promise = Promise.resolve(this.promise)
      .then(nextCall)
      .catch((reason) => {
        if (
          reason !== null &&
          typeof reason === 'object' &&
          'stack' in reason
        ) {
          const syncCallStack = syncError.stack.split(syncError.message)[1]
          reason.stack += `\n${syncCallStack}`
        }
        throw reason
      })

    function get(target: Playwright<TNext>, p: string | symbol): any {
      switch (p) {
        case 'promise':
          return promise
        case 'then':
          return promise.then.bind(promise)
        case 'catch':
          return promise.catch.bind(promise)
        case 'finally':
          return promise.finally.bind(promise)
        default:
          return target[p]
      }
    }

    return new Proxy<any>(this, {
      get,
    })
  }
}
