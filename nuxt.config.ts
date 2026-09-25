import { JobPipelinePreset } from './theme/primevue-preset'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-07-01',
  devtools: { enabled: true },

  modules: [
    // Emulates Cloudflare bindings (KV, vars, secrets) in local dev via
    // getPlatformProxy, so event.context.cloudflare.env works the same in
    // `nuxt dev` as it does on the deployed Worker.
    'nitro-cloudflare-dev',
    // Incremental adoption: available for new surfaces (tables, forms, dialogs)
    // without touching the bespoke dataviz. See theme/primevue-preset.ts.
    '@primevue/nuxt-module',
  ],

  primevue: {
    // Prefix so PrimeVue components read as `<PrimeButton>`, `<PrimeDataTable>` —
    // no collision with our own components, and obvious which is which.
    components: { prefix: 'Prime' },
    options: {
      theme: {
        preset: JobPipelinePreset,
        options: {
          // cssLayer walls all PrimeVue CSS into a @layer, so our un-layered
          // main.css always wins — the existing design is untouched.
          cssLayer: true,
          // App is dark-only; the `.dark` class is always on <html> below.
          darkModeSelector: '.dark',
        },
      },
    },
  },

  // main.css must load AFTER primeicons so our styles keep priority.
  css: ['primeicons/primeicons.css', '~/assets/css/main.css'],

  app: {
    head: {
      title: 'Job Pipeline',
      htmlAttrs: { class: 'dark', lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        // The app is dark-only (htmlAttrs class: 'dark'), so one value is right.
        { name: 'theme-color', content: '#141416' },
      ],
      link: [
        // SVG first so browsers that support it skip the raster fallbacks.
        { rel: 'icon', href: '/icons/favicon.svg', type: 'image/svg+xml' },
        { rel: 'icon', href: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { rel: 'icon', href: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
        { rel: 'manifest', href: '/icons/site.webmanifest' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@500;600&family=Spline+Sans+Mono:wght@400;500;600&display=swap',
        },
      ],
    },
  },

  runtimeConfig: {
    public: {
      // "Open in Notion →" header link. Override at runtime on Cloudflare by
      // setting a NUXT_PUBLIC_NOTION_VIEW_URL var (was NOTION_VIEW_URL).
      notionViewUrl: '',
    },
  },

  nitro: {
    // Build an ESM Worker deployed with `wrangler deploy` — keeps the app
    // behind Cloudflare Access on the custom domain, exactly like the old
    // single Worker. (NOT the Pages preset: *.pages.dev would bypass Access.)
    preset: 'cloudflare_module',

    // Cron: Nitro turns scheduledTasks into wrangler cron triggers at build
    // time. Daily snapshot ~15:00 UTC (~9am Edmonton) → KV, for trend lines.
    experimental: { tasks: true },

    // --- Realtime: PipelineHub Durable Object -----------------------------
    // Two problems solved by one build hook.
    //
    // 1. EXPORT. Cloudflare needs the DO class as a named export of the Worker
    //    entry. Nitro 2.13's cloudflare_module preset has no `cloudflare.exports`
    //    option (later Nitro), and the `cloudflare-durable` preset ships its own
    //    generic crossws $DurableObject with no role targeting, replay or worker
    //    commands. So the class is written to import nothing but
    //    `cloudflare:workers`, emitted as plain .mjs, and copied beside the entry.
    //
    // 2. UPGRADE. H3 cannot return a 101 with a `webSocket` property — a route
    //    handler that tries returns 500 (confirmed against the deployed site
    //    2026-09-10). cloudflare_module only handles upgrades through
    //    crossws/adapters/cloudflare, which lives in the request isolate and so
    //    cannot broadcast to anyone else. Cross-isolate fan-out is the whole
    //    point here, so the upgrade is intercepted in the entry, ahead of Nitro,
    //    and handed straight to the DO.
    //
    // The generated entry re-exports Nitro's handler under a minified name that
    // changes between builds, so it is read back and matched rather than
    // assumed. A miss throws and fails the build loudly instead of shipping a
    // silently broken entry.
    hooks: {
      async compiled(nitro) {
        const { copyFile, readFile, writeFile } = await import('node:fs/promises')
        const { resolve } = await import('node:path')
        const serverDir = nitro.options.output.serverDir
        const entry = resolve(serverDir, 'index.mjs')

        await copyFile(
          resolve(nitro.options.rootDir, 'server/durable/pipeline-hub.mjs'),
          resolve(serverDir, 'pipeline-hub.mjs'),
        )

        const src = await readFile(entry, 'utf8')
        const m = src.match(/export\s*\{\s*(\w+)\s+as\s+default\s*\}\s*from\s*["']([^"']+)["']/)
        if (!m) {
          throw new Error('[realtime] could not find the Nitro default export in .output/server/index.mjs — the entry shape changed, update this hook')
        }
        const [full, symbol, chunk] = m

        const wrapped = src.replace(
          full,
          `import { ${symbol} as __nitroHandler } from "${chunk}";\n` +
          `import { PipelineHub as __PipelineHub } from "./pipeline-hub.mjs";\n` +
          `export { PipelineHub } from "./pipeline-hub.mjs";\n` +
          `const __hubName = "lucas";\n` +
          `export default {\n` +
          `  async fetch(request, env, ctx) {\n` +
          `    const u = new URL(request.url);\n` +
          `    if (u.pathname === "/api/ws" && request.headers.get("upgrade") === "websocket") {\n` +
          `      if (!env.PIPELINE_HUB) return new Response("Realtime not configured", { status: 503 });\n` +
          `      return env.PIPELINE_HUB.getByName(__hubName).fetch(request);\n` +
          `    }\n` +
          `    return __nitroHandler.fetch(request, env, ctx);\n` +
          `  },\n` +
          `  async scheduled(event, env, ctx) {\n` +
          `    return __nitroHandler.scheduled?.(event, env, ctx);\n` +
          `  },\n` +
          `  async queue(batch, env, ctx) {\n` +
          `    return __nitroHandler.queue?.(batch, env, ctx);\n` +
          `  },\n` +
          `};`,
        )
        await writeFile(entry, wrapped)
        console.log('[realtime] PipelineHub exported; /api/ws upgrade intercepted ahead of Nitro')
      },
    },
    scheduledTasks: {
      '0 15 * * *': ['snapshot'],
    },

    // Access + iframe don't mix (third-party cookies) — keep the anti-embed
    // headers the original Worker sent. Access itself stays at the edge.
    routeRules: {
      '/**': {
        headers: {
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        },
      },
    },
  },
})
