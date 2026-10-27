/**
 * Whether a module is the script Node was asked to run (item c7e9e18a).
 *
 * Every hook script is also imported by its tests and by other scripts, so each
 * runs its command only when it is the entry point. That check has to see the
 * two paths the same way, or the script exits doing nothing and says nothing:
 *
 * - A file URL built by hand from process.argv[1] keeps a space where the module's
 *   own URL has `%20`. Under a folder with a space in its name, which is where the
 *   plugin runs on Ali's machine, commit-observation.mjs never ran, and no Claude
 *   Code commit was reported to DevSpec from 15 October.
 * - `pathToFileURL(argv[1])` or `path.resolve(argv[1])` keeps the path as it was
 *   typed, while Node loads the module from its real path. Reached through a
 *   symlink (a linked ~/.claude, a linked checkout), the two differ.
 *
 * Both sides are resolved to their real path here, so neither can happen.
 * entry-point.test.mjs checks no script decides this any other way.
 * Imports only Node built-ins.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} moduleUrl the calling module's `import.meta.url`
 * @param {string|undefined} argv1 the script Node was asked to run
 */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || !argv1 || typeof moduleUrl !== 'string') return false
  let modulePath
  try {
    modulePath = fileURLToPath(moduleUrl)
  } catch {
    return false
  }
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(modulePath)
  } catch {
    // A path that cannot be resolved still matches itself.
    return path.resolve(argv1) === path.resolve(modulePath)
  }
}
