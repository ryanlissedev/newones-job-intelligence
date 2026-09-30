import { defineConfig } from "@trigger.dev/sdk";

const project = process.env.TRIGGER_PROJECT_REF;
if (!project) {
  throw new Error("TRIGGER_PROJECT_REF is required");
}

export default defineConfig({
  dirs: ["./src/tasks"],
  maxDuration: 900,
  project,
  runtime: "bun",
});
