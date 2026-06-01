import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import archiver from "archiver";
import express from "express";
import rateLimit from "express-rate-limit";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const clientDir = join(__dirname, "../../public-viewer");
const outDir = join(clientDir, "out");

const ZIP_FILE_NAME = "kouchou-ai.zip";
const BUILD_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const BUILD_RATE_LIMIT_MAX_REQUESTS = 5;

const app = express();
const buildRateLimiter = rateLimit({
  windowMs: BUILD_RATE_LIMIT_WINDOW_MS,
  limit: BUILD_RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    status: "error",
    message: "Too many build requests. Please try again later.",
  },
});

app.use(express.json());

app.post("/build", buildRateLimiter, async (req, res) => {
  try {
    console.log("Build request received");
    const buildSlugs = typeof req.body.slugs === "string" ? req.body.slugs : "";
    const { stdout, stderr } = await execAsync("pnpm run build:static", {
      cwd: clientDir,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        BUILD_SLUGS: buildSlugs,
      },
    });

    console.log("Build stdout:", stdout);
    if (stderr) console.warn("Build stderr:", stderr);

    const archive = archiver("zip", { zlib: { level: 9 } });
    const zipStream = new PassThrough();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=${ZIP_FILE_NAME}`);

    archive.pipe(zipStream).pipe(res);

    archive.directory(outDir, false);
    await archive.finalize();
  } catch (err) {
    console.error("Build or Zip error:", err);
    res.status(500).json({
      status: "error",
      message: "Build failed",
    });
  }
});

app.get("/healthcheck", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const PORT = 3200;
app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
