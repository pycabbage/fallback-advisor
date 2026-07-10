import type { Configuration } from "lint-staged"

export default {
  "*.{ts,tsx,json}": ["bun lint"],
  "*.{md,mdx}": ["markdownlint-cli2"],
} satisfies Configuration
