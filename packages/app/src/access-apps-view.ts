/** Registers the website account drawer in the existing app shell without loading its form code before navigation. */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

registerAppShellPage({
  id: "access-apps",
  viewKind: "release",
  pluginId: "@elizaos/plugin-access",
  label: "Connected apps",
  icon: "Grid3x3",
  path: "/apps/access",
  loader: () =>
    import("./access-mini-app").then((module) => ({
      default: module.AccessMiniApp,
    })),
});
