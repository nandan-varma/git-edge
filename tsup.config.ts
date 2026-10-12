import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	// Declarations come from `tsc -p tsconfig.build.json` (see the build script).
	dts: false,
	target: "node22",
	splitting: false,
	sourcemap: true,
	clean: true,
});
