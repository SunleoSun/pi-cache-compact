import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : []
  })
}

test("release metadata keeps SunMemory source-only and npm test comprehensive", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))

  assert.equal(packageJson.version, packageLock.packages?.[""]?.version)
  assert.ok(fs.existsSync(path.join(root, "sun-memory", "project", "index.md")))
  assert.deepEqual(packageJson.files, ["src", "scripts", "README.md", "LICENSE"])
  assert.ok(!packageJson.files.includes("sun-memory"))
  assert.ok(!packageJson.files.includes("test"))
  assert.equal(packageJson.scripts?.test, "node --test")
  assert.match(packageJson.scripts?.certify ?? "", /npm test/)
  assert.doesNotMatch(packageJson.scripts?.certify ?? "", /test:e2e/)
  assert.equal(packageJson.scripts?.prepublishOnly, "npm run certify")

  const npmExecPath = process.env.npm_execpath
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
      })
    : spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        { cwd: root, encoding: "utf8" },
      )

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const manifest = JSON.parse(result.stdout)
  assert.equal(manifest.length, 1)
  const packedFiles = manifest[0].files.map((entry: { path: string }) => entry.path.replace(/\\/g, "/"))
  assert.ok(packedFiles.includes("src/extension.ts"))
  assert.ok(packedFiles.includes("README.md"))
  assert.ok(packedFiles.includes("LICENSE"))
  assert.ok(!packedFiles.some((file: string) => file.startsWith("sun-memory/")))
  assert.ok(!packedFiles.some((file: string) => file.startsWith("test/")))
  assert.ok(!packedFiles.some((file: string) => file.endsWith(".jsonl")))
})

test("runtime filesystem writes are confined to the debug logger", () => {
  const writeCall = /\b(?:appendFileSync|writeFileSync|appendFile|writeFile|createWriteStream|mkdirSync)\s*\(/
  const writers = sourceFiles(path.join(root, "src"))
    .filter((file) => writeCall.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).replace(/\\/g, "/"))
    .sort()

  assert.deepEqual(writers, ["src/debug.ts"])
})
