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
      ],
      link: [
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

    // --- Realtime: re-export the PipelineHub Durable Object ----------------
    // Cloudflare requires the DO class to be a named export of the Worker
    // entry. Nitro 2.13's cloudflare_module preset has no `cloudflare.exports`
    // option (that landed later, and the `cloudflare-durable` preset bundles
    // its own generic $DurableObject with no role targeting or replay, which
    // is not what this hub does). So the class is emitted as dependency-free
    // .mjs — it imports nothing but `cloudflare:workers` — and copied beside
    // the built entry, with one re-export line appended.
    //
    // Deliberately additive: it never rewrites the generated entry, so a Nitro
    // upgrade cannot silently break the app, only this one export.
    hooks: {
      async compiled(nitro) {
        const { copyFile, appendFile } = await import('node:fs/promises')
        const { resolve } = await import('node:path')
        const serverDir = nitro.options.output.serverDir
        await copyFile(
          resolve(nitro.options.rootDir, 'server/durable/pipeline-hub.mjs'),
          resolve(serverDir, 'pipeline-hub.mjs'),
        )
        await appendFile(
          resolve(serverDir, 'index.mjs'),
          '\n\n// realtime: Durable Object export (see nuxt.config.ts)\nexport { PipelineHub } from "./pipeline-hub.mjs";\n',
        )
        console.log('[realtime] PipelineHub exported from the Worker entry')
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
