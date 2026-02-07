import esbuild from "esbuild";
import process from "process";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";

const isProduction = process.argv[2] === "production";

const distDir = "dist";
const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: isProduction ? false : "inline",
  outfile: path.join(distDir, "main.js"),
  plugins: [
    {
      name: "copy-manifest",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length > 0) {
            return;
          }
          await mkdir(distDir, { recursive: true });
          await copyFile("manifest.json", path.join(distDir, "manifest.json"));
        });
      }
    }
  ]
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
