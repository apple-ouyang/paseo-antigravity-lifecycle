import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensureAntigravityHooksInstalled } from "./server/hooks.ts";

export default function contribute(server: PluginServerContext) {
  try {
    const result = ensureAntigravityHooksInstalled();
    console.log(
      `[antigravity-lifecycle] ready script=${result.scriptPath} hooks=${result.hooksJsonPath} scriptUpdated=${result.scriptUpdated} configUpdated=${result.configUpdated}`,
    );
  } catch (error) {
    console.error(
      `[antigravity-lifecycle] initial hook install failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  server.on("agent.turn_started", (event) => {
    if (event.agent.provider !== "agy") {
      return;
    }
    try {
      ensureAntigravityHooksInstalled();
    } catch (error) {
      console.error(
        `[antigravity-lifecycle] turn_started hook check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return () => {};
}
