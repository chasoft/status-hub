export function planDeploy({ argv, localConfigExists }) {
  const hasConfig = argv.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=") || arg.startsWith("-c="));
  const configPath = localConfigExists ? "wrangler.local.jsonc" : "wrangler.jsonc";
  const args = ["deploy"];
  if (!hasConfig) args.push("--config", configPath);
  args.push(...argv);
  return {
    configPath: hasConfig ? null : configPath,
    args,
    warnMissingLocal: !localConfigExists && !hasConfig,
  };
}
