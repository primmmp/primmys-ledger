import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site from https://<user>.github.io/<repo>/,
// so assets need that "/<repo>/" prefix in production. If you name the repo
// something other than "primmys-ledger", update this to match, or the site
// will load with broken CSS/JS. Local dev (`npm run dev`) is unaffected.
export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === "production" ? "/primmys-ledger/" : "/",
});
