// Custom PrimeVue theme preset — extends Aura and retunes it to the dashboard's
// existing dark palette (see app/assets/css/main.css :root tokens), so any
// PrimeVue component we add for new surfaces reads as native to the app.
//
// - surface ramp (dark): anchored to the real --bg/--panel/--card/--edge grays
// - primary: the muted gold --amber (#c2a24b), not Aura's default indigo
//
// Imported by nuxt.config at build time. cssLayer + forced dark are set there.
import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'

export const JobPipelinePreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#faf6ec',
      100: '#f2e9cf',
      200: '#e6d3a0',
      300: '#d9bd71',
      400: '#cbac57',
      500: '#c2a24b', // --amber
      600: '#a5883c',
      700: '#836a2f',
      800: '#614e24',
      900: '#43361a',
      950: '#241d0e',
    },
    colorScheme: {
      dark: {
        // 950 = --bg, 900 = --panel, 800 = --card, 700 = --panel-edge,
        // light end = --text/--muted/--faint.
        surface: {
          0: '#ffffff',
          50: '#f6f6f7',
          100: '#e9e7e2', // --text
          200: '#c9c8ce',
          300: '#a3a2ab',
          400: '#8d8c96', // --muted
          500: '#5b5a63', // --faint
          600: '#3f3f47',
          700: '#2a2a31', // --panel-edge
          800: '#232329', // --card
          900: '#1c1c20', // --panel
          950: '#141416', // --bg
        },
      },
    },
  },
})
