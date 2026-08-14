import { isAbsolute, resolve } from 'node:path';

/**
 * Every relative path in the config is resolved against the project root,
 * which is itself resolved against the directory holding the config file.
 * Collected here so no other module invents its own base-path rule.
 */
export class ProjectPaths {
  constructor(readonly rootDir: string) {}

  resolve(...segments: string[]): string {
    const [first = '.'] = segments;
    return isAbsolute(first) ? resolve(...segments) : resolve(this.rootDir, ...segments);
  }
}
