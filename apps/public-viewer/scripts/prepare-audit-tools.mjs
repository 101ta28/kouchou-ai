import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../public/audit-tools/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "kouchou-audit-tools-"));
try {
  execFileSync(process.execPath, ["apps/audit-viewer/build.mjs", temporary], { cwd: root, stdio: "inherit" });
  const build = JSON.parse(await readFile(join(temporary, "build.json"), "utf8"));
  // Address the complete distribution, including CLI and documentation, by its
  // own digest. The viewer's build ID covers only the embedded browser code.
  const archiveHash = createHash("sha256")
    .update(await readFile(join(temporary, "audit-viewer.zip")))
    .digest("hex");
  const destination = join(output, archiveHash);
  await mkdir(destination, { recursive: true });
  for (const name of ["index.html", "audit-viewer.zip", "build.json", "SHA256SUMS"]) {
    await cp(join(temporary, name), join(destination, name));
  }
  const [logoDesktop, logoMobile] = await Promise.all(
    ["logo.svg", "logo-sp.svg"].map((name) =>
      readFile(join(root, "apps/public-viewer/public/images", name), "utf8"),
    ),
  );
  const guide = (await readFile(join(root, "apps/audit-viewer/src/guide.html"), "utf8"))
    .replaceAll("__ARTIFACT__", archiveHash)
    .replaceAll("__BUILD__", build.buildSha256)
    .replaceAll("__VERSION__", build.version)
    // Reuse the site's brand assets inline: the tools' CSP blocks image requests.
    .replace("__LOGO_DESKTOP__", () => logoDesktop)
    .replace("__LOGO_MOBILE__", () => logoMobile);
  await writeFile(join(output, "guide.html"), guide);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
