import type { NextConfig } from "next"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

/**
 * `turbopack.root` is pinned to this project.
 *
 * Next infers the workspace root by walking up for a lockfile. This project
 * lives inside a harness repo that has its own pnpm-lock.yaml, so run from the
 * host Next picks the HARNESS as the root — "we detected multiple lockfiles" —
 * and resolves modules and output against the wrong directory. Inside the
 * sandbox container only this directory is mounted, so the bug is invisible
 * there and appears only when a human runs it directly, which is exactly when
 * someone is trying to look at the product.
 */
const nextConfig: NextConfig = {
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
}

export default nextConfig
