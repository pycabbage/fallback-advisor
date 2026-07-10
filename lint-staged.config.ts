import type { Configuration } from "lint-staged"

export default {
  "*.{ts,tsx,json}": ["bun lint"],
} satisfies Configuration
