export function resolveEnvBackedValue(params: {
  explicitValue?: string;
  envName?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const explicitValue = params.explicitValue?.trim();
  if (explicitValue) {
    return explicitValue;
  }
  const envName = params.envName?.trim();
  if (!envName) {
    return undefined;
  }
  const envValue = (params.env ?? process.env)[envName]?.trim();
  return envValue || undefined;
}

export function hasEnvBackedValue(params: {
  explicitValue?: string;
  envName?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return Boolean(resolveEnvBackedValue(params));
}
