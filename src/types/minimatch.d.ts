declare module "minimatch" {
  export function minimatch(
    input: string,
    pattern: string,
    options?: { dot?: boolean }
  ): boolean;
}
